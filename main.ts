// main.ts: a GitHub-compatible git forge in one Node process. It binds an ephemeral port, registers it
// with the suite at $MAKEFUN_ENV_URL, serves git smart HTTP, REST v3, GraphQL v4 and MCP from one
// in-memory store, and exits 0 once the suite says it is done.
//
// Surfaces: /{owner}/{repo}.git/(info/refs|git-upload-pack|git-receive-pack), /api/v3/..., /api/graphql,
// /mcp and /healthz. Every API reply is JSON with an X-GitHub-Request-Id header.

import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import * as F from './forge.ts';
import { infoRefs, uploadPack, receivePack } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const JSON_TYPE = 'application/json; charset=utf-8';
const REQUEST_ID_PREFIX = randomBytes(4).toString('hex').toUpperCase();
const MAX_BODY = 256 * 1024 * 1024;
let requestCounter = 0;

function requestId() {
  requestCounter += 1;
  return `${REQUEST_ID_PREFIX}:${requestCounter.toString(16).toUpperCase()}`;
}

// ------------------------------------------------------------------ replies

function sendRaw(res, status, contentType, body, headers) {
  const out = {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'x-github-request-id': requestId(),
    'x-github-media-type': 'github.v3; format=json',
  };
  if (headers) Object.assign(out, headers);
  res.writeHead(status, out);
  res.end(body);
}

function sendJson(res, status, value, headers) {
  sendRaw(res, status, JSON_TYPE, status === 204 ? '' : JSON.stringify(value), headers);
}

function sendError(res, status, message, errors, headers) {
  const body = { message, documentation_url: 'https://docs.github.com/rest', status: String(status) };
  if (errors) body.errors = errors;
  sendJson(res, status, body, headers);
}

const notFound = (res) => sendError(res, 404, 'Not Found');

// ------------------------------------------------------------------ auth

/** 'ok', 'missing' or 'bad' for the request's credentials (Bearer, token or Basic). */
function authOf(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header.trim() === '') return 'missing';
  const space = header.indexOf(' ');
  const scheme = space < 0 ? header.toLowerCase() : header.slice(0, space).toLowerCase();
  let credential = space < 0 ? '' : header.slice(space + 1).trim();
  if (scheme === 'basic') {
    const decoded = Buffer.from(credential, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    credential = colon < 0 ? decoded : decoded.slice(colon + 1);
  } else if (scheme !== 'bearer' && scheme !== 'token') {
    return 'bad';
  }
  if (credential === '') return 'missing';
  if (TOKEN === '') return 'ok';
  return credential === TOKEN ? 'ok' : 'bad';
}

function refuseAuth(res, state) {
  sendError(res, 401, state === 'missing' ? 'Requires authentication' : 'Bad credentials', undefined, { 'www-authenticate': 'Bearer realm="forge"' });
}

// ------------------------------------------------------------------ request plumbing

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      let body = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
      const encoding = String(req.headers['content-encoding'] ?? '').toLowerCase();
      if (encoding === 'gzip' || encoding === 'x-gzip') {
        try {
          body = gunzipSync(body);
        } catch (err) {
          reject(Object.assign(new Error('bad gzip body'), { status: 400 }));
          return;
        }
      }
      resolve(body);
    });
    req.on('error', reject);
  });
}

class BadJson extends Error {}

/** The JSON object of a request body ({} when empty); a parse failure is a 400. */
function jsonBody(body) {
  if (!body || body.length === 0) return {};
  const text = body.toString('utf8');
  if (text.trim() === '') return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BadJson('Problems parsing JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new BadJson('Body should be a JSON object');
  return value;
}

function originOf(req) {
  const host = req.headers.host || 'localhost';
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return `${proto}://${host}`;
}

/** A path segment percent-decoded; most segments carry no escape, so they skip the decoder. */
function decodeSegment(segment) {
  if (segment.indexOf('%') < 0) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ------------------------------------------------------------------ pagination

function pageParams(query) {
  const perRaw = parseInt(query.get('per_page') ?? '30', 10);
  const pageRaw = parseInt(query.get('page') ?? '1', 10);
  const perPage = Number.isFinite(perRaw) && perRaw > 0 ? Math.min(perRaw, 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { perPage, page };
}

/** Slice `list` by per_page/page and add GitHub's Link header (absolute URLs on this origin). */
function paginate(ctx, list) {
  const { perPage, page } = pageParams(ctx.query);
  const last = Math.max(1, Math.ceil(list.length / perPage));
  const items = list.slice((page - 1) * perPage, page * perPage);
  const link = (target) => {
    const params = new URLSearchParams(ctx.query);
    params.set('per_page', String(perPage));
    params.set('page', String(target));
    return `${ctx.origin}${ctx.path}?${params.toString()}`;
  };
  const rels = [];
  if (page > 1) rels.push(`<${link(page - 1)}>; rel="prev"`);
  if (page < last) rels.push(`<${link(page + 1)}>; rel="next"`);
  if (page < last) rels.push(`<${link(last)}>; rel="last"`);
  if (page > 1) rels.push(`<${link(1)}>; rel="first"`);
  if (rels.length) ctx.headers.link = rels.join(', ');
  return items;
}

// ------------------------------------------------------------------ git smart HTTP

const GIT_ROUTE = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

async function handleGit(req, res, match, query) {
  const state = authOf(req);
  if (state !== 'ok') {
    sendRaw(res, 401, 'text/plain; charset=utf-8', 'Authentication required\n', { 'www-authenticate': 'Basic realm="forge"' });
    return;
  }
  const repo = F.getRepo(decodeSegment(match[1]), decodeSegment(match[2]));
  const action = match[3];
  if (!repo) {
    if (req.method !== 'GET') await readBody(req).catch(() => null);
    sendRaw(res, 404, 'text/plain; charset=utf-8', 'Repository not found\n');
    return;
  }
  const v2 = String(req.headers['git-protocol'] ?? '').includes('version=2');
  if (action === 'info/refs') {
    const service = query.get('service');
    if (req.method !== 'GET' || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
      sendRaw(res, 403, 'text/plain; charset=utf-8', 'dumb HTTP is not supported; use a smart git client\n');
      return;
    }
    const answer = infoRefs(repo.git, service, v2);
    sendRaw(res, 200, answer.contentType, answer.body, { 'cache-control': 'no-cache' });
    return;
  }
  if (req.method !== 'POST') {
    sendRaw(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed\n');
    return;
  }
  const body = await readBody(req);
  if (action === 'git-upload-pack') {
    let out;
    try {
      out = uploadPack(repo.git, body, v2);
    } catch (err) {
      sendRaw(res, 400, 'text/plain; charset=utf-8', `bad upload-pack request: ${err.message}\n`);
      return;
    }
    sendRaw(res, 200, 'application/x-git-upload-pack-result', out, { 'cache-control': 'no-cache' });
    return;
  }
  let out;
  try {
    out = receivePack(repo.git, body, null);
  } catch (err) {
    sendRaw(res, 400, 'text/plain; charset=utf-8', `bad receive-pack request: ${err.message}\n`);
    return;
  }
  F.onPush(repo);
  sendRaw(res, 200, 'application/x-git-receive-pack-result', out, { 'cache-control': 'no-cache' });
}

// ------------------------------------------------------------------ REST v3

function apiRoot(origin) {
  const api = `${origin}/api/v3`;
  return {
    current_user_url: `${api}/user`,
    current_user_repositories_url: `${api}/user/repos{?type,page,per_page,sort}`,
    repository_url: `${api}/repos/{owner}/{repo}`,
    issues_url: `${api}/issues`,
    rate_limit_url: `${api}/rate_limit`,
    user_url: `${api}/users/{user}`,
    user_repositories_url: `${api}/users/{user}/repos{?type,page,per_page,sort}`,
    graphql_url: `${origin}/api/graphql`,
    mcp_url: `${origin}/mcp`,
  };
}

const SCOPES = { 'x-oauth-scopes': 'repo, read:org, workflow, gist', 'x-accepted-oauth-scopes': '' };

function sortRepos(list, query) {
  const sort = query.get('sort') ?? 'full_name';
  const direction = query.get('direction') ?? (sort === 'full_name' ? 'asc' : 'desc');
  const key = sort === 'created' ? (repo) => repo.id : sort === 'updated' || sort === 'pushed' ? (repo) => `${repo.updatedAt}|${String(repo.id).padStart(10, '0')}` : (repo) => repo.name.toLowerCase();
  const sorted = [...list].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : a.id - b.id;
  });
  if (direction === 'desc') sorted.reverse();
  return sorted;
}

function visibilityFilter(list, query) {
  const visibility = query.get('visibility');
  const type = query.get('type');
  if (visibility === 'public' || type === 'public') return list.filter((repo) => !repo.private);
  if (visibility === 'private' || type === 'private') return list.filter((repo) => repo.private);
  return list;
}

function pullAsIssueJson(repo, pull, origin) {
  const json = F.pullJson(repo, pull, origin, false);
  return {
    url: `${origin}/api/v3/repos/${F.VIEWER.login}/${repo.name}/issues/${pull.number}`,
    repository_url: `${origin}/api/v3/repos/${F.VIEWER.login}/${repo.name}`,
    html_url: json.html_url,
    id: pull.id,
    node_id: pull.nodeId,
    number: pull.number,
    title: pull.title,
    user: json.user,
    labels: json.labels,
    state: pull.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: pull.comments,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    author_association: 'OWNER',
    body: pull.body,
    draft: pull.draft,
    pull_request: { url: json.url, html_url: json.html_url, diff_url: json.diff_url, patch_url: json.patch_url, merged_at: pull.mergedAt },
  };
}

function issueNumberOf(text) {
  return /^\d{1,15}$/.test(text) ? Number(text) : NaN;
}

/** The REST router. `ctx` carries method, segments, query, origin, body and the reply headers. */
function routeRest(ctx, res) {
  const { method, seg } = ctx;
  const n = seg.length;
  if (n === 0) {
    if (method === 'GET') return sendJson(res, 200, apiRoot(ctx.origin), SCOPES);
    return notFound(res);
  }
  const top = seg[0];
  if (top === 'meta' && n === 1 && method === 'GET') {
    return sendJson(res, 200, { verifiable_password_authentication: false, installed_version: F.INSTALLED_VERSION, hooks: [], git: [], packages: [], pages: [], importer: [], actions: [], dependabot: [], domains: {} });
  }
  if (top === 'rate_limit' && n === 1 && method === 'GET') {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const core = { limit: 5000, used: 0, remaining: 5000, reset };
    return sendJson(res, 200, { resources: { core, graphql: core, search: core }, rate: core });
  }
  if (top === 'zen' && n === 1) return sendJson(res, 200, { message: 'Keep it logically awesome.' });
  if (top === 'user') {
    if (n === 1 && method === 'GET') return sendJson(res, 200, F.fullUserJson(ctx.origin));
    if (n === 2 && seg[1] === 'repos') {
      if (method === 'GET') {
        const list = paginate(ctx, sortRepos(visibilityFilter(F.listRepos(), ctx.query), ctx.query));
        return sendJson(res, 200, list.map((repo) => F.repoJson(repo, ctx.origin)), ctx.headers);
      }
      if (method === 'POST') {
        const repo = F.createRepo(ctx.json());
        return sendJson(res, 201, F.repoJson(repo, ctx.origin), { location: `${ctx.origin}/api/v3/repos/${F.VIEWER.login}/${repo.name}` });
      }
    }
    return notFound(res);
  }
  if (top === 'users' && n >= 2) {
    if (!F.isViewer(seg[1])) return notFound(res);
    if (n === 2 && method === 'GET') return sendJson(res, 200, F.fullUserJson(ctx.origin));
    if (n === 3 && seg[2] === 'repos' && method === 'GET') {
      const list = paginate(ctx, sortRepos(F.listRepos().filter((repo) => !repo.private), ctx.query));
      return sendJson(res, 200, list.map((repo) => F.repoJson(repo, ctx.origin)), ctx.headers);
    }
    return notFound(res);
  }
  if (top === 'orgs' && n === 3 && seg[2] === 'repos' && method === 'POST' && F.isViewer(seg[1])) {
    const repo = F.createRepo(ctx.json());
    return sendJson(res, 201, F.repoJson(repo, ctx.origin));
  }
  if (top === 'repos' && n >= 3) return routeRepo(ctx, res);
  return notFound(res);
}

function routeRepo(ctx, res) {
  const { method, seg, origin } = ctx;
  const repo = F.getRepo(seg[1], seg[2]);
  if (!repo) return sendError(res, 404, 'Not Found');
  const n = seg.length;
  if (n === 3) {
    if (method === 'GET') return sendJson(res, 200, F.repoJson(repo, origin));
    if (method === 'PATCH') return sendJson(res, 200, F.repoJson(F.updateRepo(repo, ctx.json()), origin));
    if (method === 'DELETE') {
      F.deleteRepo(repo);
      return sendJson(res, 204, null);
    }
    return notFound(res);
  }
  const area = seg[3];
  const git = repo.git;
  switch (area) {
    case 'branches': {
      if (method !== 'GET') return notFound(res);
      if (n === 4) {
        const names = git.branchNames();
        return sendJson(res, 200, paginate(ctx, names).map((name) => F.branchJson(repo, origin, name)), ctx.headers);
      }
      const name = seg.slice(4).join('/');
      if (!git.refs.has(`refs/heads/${name}`)) return sendError(res, 404, 'Branch not found');
      const json = F.branchJson(repo, origin, name);
      json.commit = F.commitJson(repo, origin, json.commit.sha);
      json._links = { self: `${origin}/api/v3/repos/${F.VIEWER.login}/${repo.name}/branches/${name}`, html: `${origin}/${F.VIEWER.login}/${repo.name}/tree/${name}` };
      return sendJson(res, 200, json);
    }
    case 'commits': {
      if (method !== 'GET') return notFound(res);
      if (git.isEmpty()) return sendError(res, 409, 'Git Repository is empty.');
      if (n === 4) {
        const tip = git.resolve(ctx.query.get('sha') ?? undefined);
        if (!tip) return sendError(res, 404, 'No commit found for SHA: ' + (ctx.query.get('sha') ?? 'HEAD'));
        const { perPage, page } = pageParams(ctx.query);
        let oids = git.log(tip, ctx.query.get('path') ? Infinity : perPage * page + 1);
        const path = ctx.query.get('path');
        if (path) {
          oids = oids.filter((oid) => {
            const commit = git.commit(oid);
            const here = git.lookupPath(oid, path)?.oid ?? null;
            if (commit.parents.length === 0) return here !== null;
            return commit.parents.some((parent) => (git.lookupPath(parent, path)?.oid ?? null) !== here);
          });
        }
        return sendJson(res, 200, paginate(ctx, oids).map((oid) => F.commitJson(repo, origin, oid)), ctx.headers);
      }
      const oid = git.resolve(seg.slice(4).join('/'));
      if (!oid || !git.commit(oid)) return sendError(res, 422, `No commit found for SHA: ${seg.slice(4).join('/')}`);
      const json = F.commitJson(repo, origin, oid);
      const commit = git.commit(oid);
      const parentTree = commit.parents.length ? git.commit(commit.parents[0])?.tree ?? null : null;
      const before = git.flatten(parentTree);
      const after = git.flatten(commit.tree);
      const files = [];
      for (const path of new Set([...before.keys(), ...after.keys()])) {
        const a = before.get(path);
        const b = after.get(path);
        if (a && b && a.oid === b.oid) continue;
        files.push({ sha: (b ?? a).oid, filename: path, status: !a ? 'added' : !b ? 'removed' : 'modified', additions: 0, deletions: 0, changes: 0 });
      }
      json.files = files;
      json.stats = { total: 0, additions: 0, deletions: 0 };
      return sendJson(res, 200, json);
    }
    case 'contents':
      return routeContents(ctx, res, repo);
    case 'readme': {
      if (method !== 'GET') return notFound(res);
      const tip = git.resolve(ctx.query.get('ref') ?? undefined);
      const entry = tip ? ['README.md', 'README', 'readme.md', 'README.txt'].map((name) => git.lookupPath(tip, name)).find((item) => item && item.type === 'blob') : null;
      if (!entry) return sendError(res, 404, 'Not Found');
      return sendJson(res, 200, contentFileJson(repo, origin, entry.name, entry, ctx.query.get('ref')));
    }
    case 'git':
      return routeGitData(ctx, res, repo);
    case 'labels':
      return routeLabels(ctx, res, repo);
    case 'issues':
      return routeIssues(ctx, res, repo);
    case 'pulls':
      return routePulls(ctx, res, repo);
    case 'collaborators':
      if (method === 'GET' && n === 4) return sendJson(res, 200, [F.userJson(origin)]);
      if (method === 'GET' && n === 5) return F.isViewer(seg[4]) ? sendJson(res, 204, null) : notFound(res);
      return notFound(res);
    case 'tags': {
      if (method !== 'GET' || n !== 4) return notFound(res);
      const tags = [...git.refs.keys()].filter((ref) => ref.startsWith('refs/tags/')).sort().reverse();
      return sendJson(res, 200, paginate(ctx, tags).map((ref) => {
        const sha = git.peel(git.refs.get(ref));
        return { name: ref.slice(10), commit: { sha, url: `${origin}/api/v3/repos/${F.VIEWER.login}/${repo.name}/commits/${sha}` } };
      }), ctx.headers);
    }
    default:
      return notFound(res);
  }
}

function contentFileJson(repo, origin, path, entry, ref) {
  const json = F.contentEntryJson(repo, origin, path, entry, ref);
  const data = repo.git.get(entry.oid)?.data ?? Buffer.alloc(0);
  const encoded = data.toString('base64').replace(/(.{60})/g, '$1\n');
  return { ...json, content: encoded.endsWith('\n') || encoded === '' ? encoded : `${encoded}\n`, encoding: 'base64' };
}

function routeContents(ctx, res, repo) {
  const { method, seg, origin } = ctx;
  const path = seg.slice(4).join('/');
  const git = repo.git;
  if (method === 'GET') {
    const ref = ctx.query.get('ref');
    if (git.isEmpty()) return sendError(res, 404, 'This repository is empty.');
    const tip = git.resolve(ref ?? undefined);
    if (!tip) return sendError(res, 404, `No commit found for the ref ${ref}`);
    const entry = git.lookupPath(tip, path);
    if (!entry) return sendError(res, 404, 'Not Found');
    if (entry.type === 'tree') {
      const prefix = path.replace(/^\/+|\/+$/g, '');
      const entries = (git.tree(entry.oid) ?? []).map((child) => {
        const childPath = prefix === '' ? child.name : `${prefix}/${child.name}`;
        return F.contentEntryJson(repo, origin, childPath, { type: child.mode === '40000' ? 'tree' : 'blob', mode: child.mode, oid: child.oid }, ref);
      });
      entries.sort((a, b) => (a.type === b.type ? (a.name < b.name ? -1 : 1) : a.type === 'dir' ? -1 : 1));
      return sendJson(res, 200, entries);
    }
    return sendJson(res, 200, contentFileJson(repo, origin, path.replace(/^\/+|\/+$/g, ''), entry, ref));
  }
  if (method === 'PUT') {
    const result = F.putContents(repo, path, ctx.json());
    const entry = { type: 'blob', mode: '100644', oid: result.blobOid };
    return sendJson(res, result.created ? 201 : 200, {
      content: { ...F.contentEntryJson(repo, origin, result.path, entry, null), encoding: 'base64' },
      commit: F.gitCommitJson(repo, origin, result.commitOid),
    });
  }
  if (method === 'DELETE') {
    const result = F.deleteContents(repo, path, ctx.json());
    return sendJson(res, 200, { content: null, commit: F.gitCommitJson(repo, origin, result.commitOid) });
  }
  return notFound(res);
}

function routeGitData(ctx, res, repo) {
  const { method, seg, origin } = ctx;
  const git = repo.git;
  const kind = seg[4];
  const rest = seg.slice(5).join('/');
  if (kind === 'refs' || kind === 'ref' || kind === 'matching-refs') {
    if (method === 'GET') {
      if (kind === 'refs' && rest === '') {
        const refs = [...git.refs.keys()].sort();
        return sendJson(res, 200, paginate(ctx, refs).map((ref) => F.refJson(repo, origin, ref)), ctx.headers);
      }
      const full = `refs/${rest}`;
      if (kind === 'matching-refs') {
        return sendJson(res, 200, [...git.refs.keys()].filter((ref) => ref.startsWith(full)).sort().map((ref) => F.refJson(repo, origin, ref)));
      }
      if (git.refs.has(full)) return sendJson(res, 200, F.refJson(repo, origin, full));
      const matches = [...git.refs.keys()].filter((ref) => ref.startsWith(`${full}/`)).sort();
      if (kind === 'refs' && matches.length) return sendJson(res, 200, matches.map((ref) => F.refJson(repo, origin, ref)));
      return sendError(res, 404, 'Not Found');
    }
    if (kind === 'refs' && method === 'POST' && rest === '') {
      const body = ctx.json();
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha.toLowerCase() : '';
      if (!ref.startsWith('refs/') || ref.split('/').length < 3) return sendError(res, 422, 'Reference name must start with \'refs/\' and have at least two slashes.');
      if (git.refs.has(ref)) return sendError(res, 422, 'Reference already exists');
      if (!git.has(sha)) return sendError(res, 422, 'Object does not exist');
      if (git.isEmpty() && ref.startsWith('refs/heads/') && !git.refs.has(git.head)) git.head = ref;
      git.refs.set(ref, sha);
      git.touch();
      F.onPush(repo);
      return sendJson(res, 201, F.refJson(repo, origin, ref), { location: `${origin}/api/v3/repos/${F.VIEWER.login}/${repo.name}/git/${ref}` });
    }
    if (kind === 'refs' && rest !== '') {
      const full = `refs/${rest}`;
      if (!git.refs.has(full)) return sendError(res, 422, 'Reference does not exist');
      if (method === 'PATCH') {
        const body = ctx.json();
        const sha = typeof body.sha === 'string' ? body.sha.toLowerCase() : '';
        if (!git.has(sha)) return sendError(res, 422, 'Object does not exist');
        const current = git.refs.get(full);
        if (full.startsWith('refs/heads/') && body.force !== true && !git.isAncestor(current, sha)) return sendError(res, 422, 'Update is not a fast forward');
        git.refs.set(full, sha);
        git.touch();
        F.onPush(repo);
        return sendJson(res, 200, F.refJson(repo, origin, full));
      }
      if (method === 'DELETE') {
        git.refs.delete(full);
        git.touch();
        F.onPush(repo);
        return sendJson(res, 204, null);
      }
    }
    return notFound(res);
  }
  if (method === 'GET' && rest !== '' && (kind === 'commits' || kind === 'trees' || kind === 'blobs' || kind === 'tags')) {
    const oid = rest.toLowerCase();
    const object = git.get(oid);
    const expected = { commits: 'commit', trees: 'tree', blobs: 'blob', tags: 'tag' }[kind];
    if (!object || object.type !== expected) return sendError(res, 404, 'Not Found');
    const api = `${origin}/api/v3/repos/${F.VIEWER.login}/${repo.name}/git`;
    if (kind === 'commits') return sendJson(res, 200, F.gitCommitJson(repo, origin, oid));
    if (kind === 'blobs') return sendJson(res, 200, { sha: oid, node_id: F.nodeIdOf('B', 'Blob', oid), size: object.data.length, url: `${api}/blobs/${oid}`, content: object.data.toString('base64'), encoding: 'base64' });
    if (kind === 'tags') {
      const text = object.data.toString('utf8');
      const tagName = /^tag (.*)$/m.exec(text)?.[1] ?? '';
      const target = /^object (.*)$/m.exec(text)?.[1] ?? '';
      const type = /^type (.*)$/m.exec(text)?.[1] ?? 'commit';
      return sendJson(res, 200, { sha: oid, tag: tagName, message: text.slice(text.indexOf('\n\n') + 2), object: { sha: target, type, url: `${api}/${type}s/${target}` }, url: `${api}/tags/${oid}` });
    }
    const recursive = ctx.query.has('recursive') && ctx.query.get('recursive') !== '0' && ctx.query.get('recursive') !== 'false';
    const tree = [];
    const walk = (treeOid, prefix) => {
      for (const entry of git.tree(treeOid) ?? []) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        const isTree = entry.mode === '40000';
        tree.push({ path, mode: isTree ? '040000' : entry.mode, type: isTree ? 'tree' : entry.mode === '160000' ? 'commit' : 'blob', sha: entry.oid, size: isTree ? undefined : git.get(entry.oid)?.data.length, url: `${api}/${isTree ? 'trees' : 'blobs'}/${entry.oid}` });
        if (isTree && recursive) walk(entry.oid, path);
      }
    };
    walk(oid, '');
    return sendJson(res, 200, { sha: oid, url: `${api}/trees/${oid}`, tree, truncated: false });
  }
  return notFound(res);
}

function routeLabels(ctx, res, repo) {
  const { method, seg, origin } = ctx;
  if (seg.length === 4) {
    if (method === 'GET') {
      const labels = [...repo.labels.values()].sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
      return sendJson(res, 200, paginate(ctx, labels).map((label) => F.labelJson(repo, origin, label)), ctx.headers);
    }
    if (method === 'POST') return sendJson(res, 201, F.labelJson(repo, origin, F.createLabel(repo, ctx.json())));
    return notFound(res);
  }
  const name = seg.slice(4).join('/');
  const label = repo.labels.get(name.toLowerCase());
  if (!label) return sendError(res, 404, 'Not Found');
  if (method === 'GET') return sendJson(res, 200, F.labelJson(repo, origin, label));
  if (method === 'PATCH') {
    const body = ctx.json();
    if (typeof body.new_name === 'string' && body.new_name !== label.name) {
      if (repo.labels.has(body.new_name.toLowerCase())) return sendError(res, 422, 'Validation Failed', [{ resource: 'Label', code: 'already_exists', field: 'name' }]);
      repo.labels.delete(label.name.toLowerCase());
      for (const item of [...repo.issues.values(), ...repo.pulls.values()]) item.labels = item.labels.map((entry) => (entry.toLowerCase() === label.name.toLowerCase() ? body.new_name : entry));
      label.name = body.new_name;
      repo.labels.set(label.name.toLowerCase(), label);
    }
    if (typeof body.color === 'string') label.color = body.color.replace('#', '');
    if (body.description !== undefined) label.description = body.description;
    repo.epoch += 1;
    return sendJson(res, 200, F.labelJson(repo, origin, label));
  }
  if (method === 'DELETE') {
    repo.labels.delete(label.name.toLowerCase());
    for (const item of [...repo.issues.values(), ...repo.pulls.values()]) item.labels = item.labels.filter((entry) => entry.toLowerCase() !== label.name.toLowerCase());
    repo.epoch += 1;
    return sendJson(res, 204, null);
  }
  return notFound(res);
}

function routeIssues(ctx, res, repo) {
  const { method, seg, origin } = ctx;
  const n = seg.length;
  if (n === 4) {
    if (method === 'GET') {
      const labels = ctx.query.get('labels');
      const list = F.queryIssues(repo, {
        state: ctx.query.get('state') ?? 'open',
        sort: ctx.query.get('sort') ?? 'created',
        direction: ctx.query.get('direction') ?? 'desc',
        labels: labels ? labels.split(',').map((name) => name.trim()).filter(Boolean) : null,
      });
      return sendJson(res, 200, paginate(ctx, list).map((issue) => F.issueJson(repo, issue, origin)), ctx.headers);
    }
    if (method === 'POST') return sendJson(res, 201, F.issueJson(repo, F.createIssue(repo, ctx.json()), origin));
    return notFound(res);
  }
  if (seg[4] === 'comments') {
    if (n === 5 && method === 'GET') {
      const all = [...repo.comments.values()].flat().sort((a, b) => a.id - b.id);
      return sendJson(res, 200, paginate(ctx, all).map((comment) => F.commentJson(repo, origin, comment)), ctx.headers);
    }
    if (n !== 6) return notFound(res);
    const comment = F.findComment(repo, issueNumberOf(seg[5]));
    if (!comment) return sendError(res, 404, 'Not Found');
    if (method === 'GET') return sendJson(res, 200, F.commentJson(repo, origin, comment));
    if (method === 'PATCH') {
      const body = ctx.json();
      if (typeof body.body !== 'string') return sendError(res, 422, 'Validation Failed', [{ resource: 'IssueComment', code: 'missing_field', field: 'body' }]);
      comment.body = body.body;
      comment.updatedAt = F.isoNow();
      return sendJson(res, 200, F.commentJson(repo, origin, comment));
    }
    if (method === 'DELETE') {
      F.deleteComment(repo, comment);
      return sendJson(res, 204, null);
    }
    return notFound(res);
  }
  const number = issueNumberOf(seg[4]);
  const issue = repo.issues.get(number);
  const pull = issue ? null : repo.pulls.get(number);
  if (!issue && !pull) return sendError(res, 404, 'Not Found');
  if (n === 5) {
    if (method === 'GET') {
      if (issue) return sendRaw(res, 200, JSON_TYPE, F.issueText(repo, issue, origin));
      return sendJson(res, 200, pullAsIssueJson(repo, pull, origin));
    }
    if (method === 'PATCH') {
      if (issue) return sendJson(res, 200, F.issueJson(repo, F.updateIssue(repo, issue, ctx.json()), origin));
      const body = ctx.json();
      if (body.labels !== undefined) pull.labels = F.resolveLabels(repo, body.labels);
      F.updatePull(repo, pull, body);
      return sendJson(res, 200, pullAsIssueJson(repo, pull, origin));
    }
    return notFound(res);
  }
  const target = issue ?? pull;
  if (seg[5] === 'comments' && n === 6) {
    if (method === 'GET') {
      const list = repo.comments.get(number) ?? [];
      return sendJson(res, 200, paginate(ctx, list).map((comment) => F.commentJson(repo, origin, comment)), ctx.headers);
    }
    if (method === 'POST') {
      const comment = F.addComment(repo, number, ctx.json().body);
      return sendJson(res, 201, F.commentJson(repo, origin, comment));
    }
    return notFound(res);
  }
  if (seg[5] === 'labels') {
    const json = () => target.labels.map((name) => repo.labels.get(name.toLowerCase())).filter(Boolean).map((label) => F.labelJson(repo, origin, label));
    const touch = () => { if (issue) F.updateIssue(repo, issue, {}); else repo.epoch += 1; };
    if (n === 6 && method === 'GET') return sendJson(res, 200, json());
    if (n === 6 && (method === 'POST' || method === 'PUT')) {
      const body = ctx.json();
      const names = F.resolveLabels(repo, Array.isArray(body.labels) ? body.labels : []);
      target.labels = method === 'PUT' ? names : [...new Set([...target.labels, ...names])];
      touch();
      return sendJson(res, 200, json());
    }
    if (n === 6 && method === 'DELETE') {
      target.labels = [];
      touch();
      return sendJson(res, 204, null);
    }
    if (n === 7 && method === 'DELETE') {
      const name = seg[6].toLowerCase();
      if (!target.labels.some((entry) => entry.toLowerCase() === name)) return sendError(res, 404, 'Label does not exist');
      target.labels = target.labels.filter((entry) => entry.toLowerCase() !== name);
      touch();
      return sendJson(res, 200, json());
    }
  }
  return notFound(res);
}

function routePulls(ctx, res, repo) {
  const { method, seg, origin } = ctx;
  const n = seg.length;
  if (n === 4) {
    if (method === 'GET') {
      const list = F.queryPulls(repo, {
        state: ctx.query.get('state') ?? 'open',
        head: ctx.query.get('head'),
        base: ctx.query.get('base'),
        sort: ctx.query.get('sort') ?? 'created',
        direction: ctx.query.get('direction') ?? 'desc',
      });
      return sendJson(res, 200, paginate(ctx, list).map((pull) => F.pullJson(repo, pull, origin, false)), ctx.headers);
    }
    if (method === 'POST') return sendJson(res, 201, F.pullJson(repo, F.createPull(repo, ctx.json()), origin));
    return notFound(res);
  }
  const pull = repo.pulls.get(issueNumberOf(seg[4]));
  if (!pull) return sendError(res, 404, 'Not Found');
  if (n === 5) {
    if (method === 'GET') return sendJson(res, 200, F.pullJson(repo, pull, origin));
    if (method === 'PATCH') return sendJson(res, 200, F.pullJson(repo, F.updatePull(repo, pull, ctx.json()), origin));
    return notFound(res);
  }
  if (n === 6 && seg[5] === 'files' && method === 'GET') {
    const head = F.pullTips(repo, pull).head;
    return sendJson(res, 200, paginate(ctx, F.pullFiles(repo, pull)).map((file) => F.pullFileJson(repo, origin, file, head)), ctx.headers);
  }
  if (n === 6 && seg[5] === 'commits' && method === 'GET') {
    const { head, base } = F.pullTips(repo, pull);
    const exclude = base ? repo.git.ancestors(base) : new Set();
    const oids = head ? repo.git.log(head).filter((oid) => !exclude.has(oid)).reverse() : [];
    return sendJson(res, 200, paginate(ctx, oids).map((oid) => F.commitJson(repo, origin, oid)), ctx.headers);
  }
  if (n === 6 && seg[5] === 'merge') {
    if (method === 'GET') return pull.merged ? sendJson(res, 204, null) : sendError(res, 404, 'Not Found');
    if (method === 'PUT') {
      const body = ctx.json();
      return sendJson(res, 200, F.mergePull(repo, pull, { method: body.merge_method, title: body.commit_title, message: body.commit_message, sha: body.sha }));
    }
  }
  return notFound(res);
}

// ------------------------------------------------------------------ the server

function handleRest(req, res, path, query, body) {
  const state = authOf(req);
  if (state !== 'ok') return refuseAuth(res, state);
  const rest = path.length > 7 ? path.slice(8) : '';
  // One pass over the segments: a trailing slash drops its empty last segment, inner empties stay.
  const seg = rest === '' ? [] : rest.split('/');
  if (seg.length > 0 && seg[seg.length - 1] === '') seg.pop();
  for (let i = 0; i < seg.length; i += 1) seg[i] = decodeSegment(seg[i]);
  const ctx = {
    method: req.method,
    seg,
    query,
    origin: originOf(req),
    path,
    headers: {},
    json: () => jsonBody(body),
  };
  routeRest(ctx, res);
}

async function dispatch(req, res) {
  const url = req.url ?? '/';
  const q = url.indexOf('?');
  const path = q < 0 ? url : url.slice(0, q);
  const query = new URLSearchParams(q < 0 ? '' : url.slice(q + 1));
  const method = req.method ?? 'GET';
  if (path === '/healthz' || path === '/health') return sendJson(res, 200, { ok: true });
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (method === 'GET' || method === 'HEAD') return handleRest(req, res, path, query, null);
    const body = await readBody(req);
    return handleRest(req, res, path, query, body);
  }
  if (path === '/api/graphql' || path === '/graphql' || path === '/api/v3/graphql') {
    if (method !== 'POST') return notFound(res);
    const body = await readBody(req);
    const state = authOf(req);
    if (state !== 'ok') return refuseAuth(res, state);
    const answer = handleGraphQL(body, originOf(req));
    return sendJson(res, answer.status, answer.body);
  }
  if (path === '/mcp' || path === '/mcp/') {
    const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    const state = authOf(req);
    if (state !== 'ok') {
      return sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: state === 'missing' ? 'Authentication required' : 'Bad credentials' } }, { 'www-authenticate': 'Bearer realm="forge"' });
    }
    const answer = handleMcp(req, body, originOf(req));
    return sendRaw(res, answer.status, answer.contentType, answer.body, answer.headers);
  }
  const git = GIT_ROUTE.exec(path);
  if (git) return handleGit(req, res, git, query);
  return notFound(res);
}

function onRequest(req, res) {
  let result;
  try {
    result = dispatch(req, res);
  } catch (err) {
    failRequest(res, err);
    return;
  }
  if (result && typeof result.then === 'function') result.catch((err) => failRequest(res, err));
}

function failRequest(res, err) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof F.ForgeError) return sendError(res, err.status, err.message, err.errors);
  if (err instanceof BadJson) return sendError(res, 400, err.message);
  if (err && typeof err.status === 'number') return sendError(res, err.status, err.message);
  process.stderr.write(`[forge] internal error: ${err && err.stack ? err.stack : err}\n`);
  sendError(res, 500, 'Internal Server Error');
}

// ------------------------------------------------------------------ lifecycle

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function register(port) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30_000),
      });
      await res.arrayBuffer().catch(() => null);
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered')) throw err;
    }
    await sleep(Math.min(2000, 100 * 2 ** Math.min(attempt, 5)));
  }
}

async function waitForDone() {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        const body = await res.json();
        if (body && body.done === true) return;
      } else {
        await res.arrayBuffer().catch(() => null);
      }
    } catch {
      // not answering yet: poll again
    }
    await sleep(attempt < 5 ? 250 : 1000);
  }
}

async function main() {
  const server = createServer({ keepAliveTimeout: 120_000, headersTimeout: 125_000, requestTimeout: 0, noDelay: true }, onRequest);
  server.keepAliveTimeout = 120_000;
  server.on('clientError', (err, socket) => {
    if (!socket.writable) return;
    const body = JSON.stringify({ message: 'Bad Request', documentation_url: 'https://docs.github.com/rest', status: '400' });
    socket.end(
      'HTTP/1.1 400 Bad Request\r\n' +
        `Content-Type: ${JSON_TYPE}\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `X-GitHub-Request-Id: ${requestId()}\r\n` +
        `Connection: close\r\n\r\n${body}`,
    );
  });
  const standalonePort = process.env.MAKEFUN_FORGE_PORT;
  if (ENV_URL === '' && !standalonePort) {
    process.stderr.write('[forge] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
    process.exit(1);
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(ENV_URL === '' ? Number(standalonePort) : 0, () => resolve(undefined));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind a TCP port');
  process.stdout.write(`[forge] listening on port ${address.port}\n`);
  if (ENV_URL === '') return; // standalone: serve until killed
  await register(address.port);
  process.stdout.write('[forge] registered; waiting for the env to say done\n');
  await waitForDone();
  server.close();
  process.stdout.write('[forge] done\n');
  process.exit(0);
}

process.on('uncaughtException', (err) => {
  process.stderr.write(`[forge] uncaught: ${err && err.stack ? err.stack : err}\n`);
});
process.on('unhandledRejection', (err) => {
  process.stderr.write(`[forge] unhandled rejection: ${err && err.stack ? err.stack : err}\n`);
});

main().catch((err) => {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
