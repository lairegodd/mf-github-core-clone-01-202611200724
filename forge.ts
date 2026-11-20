// forge.ts: the forge's one store and its operations. Repositories (each with its git object database),
// labels, issues, comments and pull requests live here, and REST, GraphQL and MCP all act through these
// functions, so an object created on one surface reads back identically on the others. The JSON builders
// render GitHub's REST v3 shapes.

import { GitStore, ZERO_OID, serializeCommit } from './git.ts';

/** The login the trial's token names: the suite's seeded viewer (overridable for other harnesses). */
export const VIEWER = Object.freeze({
  login: process.env.MAKEFUN_FORGE_LOGIN || 'adaiversen',
  id: Number(process.env.MAKEFUN_FORGE_USER_ID || 1000),
  name: process.env.MAKEFUN_FORGE_NAME || 'ada iversen',
});
// The viewer's commit identity: name above, e-mail below.
export const VIEWER_EMAIL = process.env.MAKEFUN_FORGE_EMAIL || `${VIEWER.login}@example.invalid`;
export const INSTALLED_VERSION = '3.15.0';

export class ForgeError extends Error {
  constructor(status, message, errors) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

export const store = {
  repos: new Map(), // lower-case name -> repo (every repository belongs to the viewer)
  nodes: new Map(), // global node id -> { kind, repo, item }
  nextRepoId: 1,
  nextIssueId: 1,
  nextPullId: 1,
  nextCommentId: 1,
  nextLabelId: 1,
  seq: 0,
};

export function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function nodeIdOf(prefix, kind, id) {
  return `${prefix}_${Buffer.from(`0${kind}:${id}`).toString('base64url')}`;
}

function register(item, kind, repo) {
  store.nodes.set(item.nodeId, { kind, repo, item });
}

/** A node by its global id, or null (the repository must still exist). */
export function lookupNode(id) {
  const entry = store.nodes.get(id);
  if (!entry) return null;
  if (store.repos.get(entry.repo.name.toLowerCase()) !== entry.repo) return null;
  if (entry.kind === 'Issue' && entry.repo.issues.get(entry.item.number) !== entry.item) return null;
  return entry;
}

// ------------------------------------------------------------------ users

export function isViewer(login) {
  return typeof login === 'string' && login.toLowerCase() === VIEWER.login.toLowerCase();
}

export function userJson(origin) {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: nodeIdOf('U', 'User', VIEWER.id),
    avatar_url: `${origin}/avatars/${VIEWER.login}`,
    gravatar_id: '',
    url: `${origin}/api/v3/users/${VIEWER.login}`,
    html_url: `${origin}/${VIEWER.login}`,
    repos_url: `${origin}/api/v3/users/${VIEWER.login}/repos`,
    type: 'User',
    site_admin: false,
  };
}

export function fullUserJson(origin) {
  return {
    ...userJson(origin),
    name: VIEWER.name,
    company: null,
    blog: '',
    location: null,
    email: VIEWER_EMAIL,
    bio: null,
    public_repos: [...store.repos.values()].filter((repo) => !repo.private).length,
    total_private_repos: [...store.repos.values()].filter((repo) => repo.private).length,
    followers: 0,
    following: 0,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };
}

// ------------------------------------------------------------------ repositories

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function getRepo(owner, name) {
  if (!isViewer(owner) || typeof name !== 'string') return null;
  return store.repos.get(name.toLowerCase()) ?? null;
}

export function listRepos() {
  return [...store.repos.values()];
}

export function defaultBranch(repo) {
  return repo.git.head.startsWith('refs/heads/') ? repo.git.head.slice(11) : repo.git.head;
}

export function createRepo(input) {
  const name = input && typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new ForgeError(422, 'Repository creation failed.', [{ resource: 'Repository', code: 'missing_field', field: 'name' }]);
  if (!NAME_RE.test(name) || name === '.' || name === '..' || name.toLowerCase().endsWith('.git')) {
    throw new ForgeError(422, 'Repository creation failed.', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name is invalid' }]);
  }
  if (store.repos.has(name.toLowerCase())) {
    throw new ForgeError(422, 'Repository creation failed.', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }]);
  }
  const now = isoNow();
  const id = store.nextRepoId++;
  const repo = {
    id,
    nodeId: nodeIdOf('R', 'Repository', id),
    name,
    description: typeof input.description === 'string' ? input.description : null,
    homepage: typeof input.homepage === 'string' ? input.homepage : null,
    private: input.private === true || input.visibility === 'private' || input.visibility === 'PRIVATE',
    hasIssues: input.has_issues !== false,
    hasWiki: input.has_wiki !== false,
    hasProjects: input.has_projects !== false,
    createdAt: now,
    updatedAt: now,
    pushedAt: null,
    git: new GitStore(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    comments: new Map(),
    nextNumber: 1,
    epoch: 0,
  };
  if (typeof input.default_branch === 'string' && input.default_branch) repo.git.head = `refs/heads/${input.default_branch}`;
  store.repos.set(name.toLowerCase(), repo);
  register(repo, 'Repository', repo);
  if (input.auto_init === true) {
    commitFiles(repo, {
      branch: defaultBranch(repo),
      changes: [{ path: 'README.md', content: Buffer.from(`# ${name}\n${repo.description ? `\n${repo.description}\n` : ''}`) }],
      message: 'Initial commit',
    });
  }
  return repo;
}

export function updateRepo(repo, patch) {
  if (patch.name !== undefined && patch.name !== repo.name) {
    if (typeof patch.name !== 'string' || !NAME_RE.test(patch.name)) throw new ForgeError(422, 'Validation Failed', [{ resource: 'Repository', code: 'invalid', field: 'name' }]);
    if (store.repos.has(patch.name.toLowerCase()) && store.repos.get(patch.name.toLowerCase()) !== repo) {
      throw new ForgeError(422, 'Validation Failed', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }]);
    }
    store.repos.delete(repo.name.toLowerCase());
    repo.name = patch.name;
    store.repos.set(repo.name.toLowerCase(), repo);
  }
  if (patch.description !== undefined) repo.description = patch.description === null ? null : String(patch.description);
  if (patch.homepage !== undefined) repo.homepage = patch.homepage === null ? null : String(patch.homepage);
  if (patch.private !== undefined) repo.private = patch.private === true;
  if (patch.visibility !== undefined) repo.private = String(patch.visibility).toLowerCase() === 'private';
  if (patch.has_issues !== undefined) repo.hasIssues = patch.has_issues !== false;
  if (patch.default_branch !== undefined) {
    const branch = String(patch.default_branch);
    if (!repo.git.isEmpty() && !repo.git.refs.has(`refs/heads/${branch}`)) {
      throw new ForgeError(422, 'Validation Failed', [{ resource: 'Repository', code: 'invalid', field: 'default_branch' }]);
    }
    repo.git.head = `refs/heads/${branch}`;
    repo.git.touch();
  }
  repo.updatedAt = isoNow();
  repo.epoch += 1;
  return repo;
}

export function deleteRepo(repo) {
  store.repos.delete(repo.name.toLowerCase());
  store.nodes.delete(repo.nodeId);
}

export function repoJson(repo, origin) {
  const full = `${VIEWER.login}/${repo.name}`;
  const api = `${origin}/api/v3/repos/${full}`;
  const openIssues = countOpen(repo);
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: full,
    private: repo.private,
    owner: userJson(origin),
    html_url: `${origin}/${full}`,
    description: repo.description,
    fork: false,
    url: api,
    issues_url: `${api}/issues{/number}`,
    pulls_url: `${api}/pulls{/number}`,
    contents_url: `${api}/contents/{+path}`,
    branches_url: `${api}/branches{/branch}`,
    commits_url: `${api}/commits{/sha}`,
    labels_url: `${api}/labels{/name}`,
    git_refs_url: `${api}/git/refs{/sha}`,
    clone_url: `${origin}/${full}.git`,
    git_url: `${origin}/${full}.git`,
    ssh_url: `git@forge:${full}.git`,
    svn_url: `${origin}/${full}`,
    homepage: repo.homepage,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: openIssues,
    language: null,
    has_issues: repo.hasIssues,
    has_projects: repo.hasProjects,
    has_wiki: repo.hasWiki,
    has_pages: false,
    has_downloads: true,
    has_discussions: false,
    archived: false,
    disabled: false,
    is_template: false,
    visibility: repo.private ? 'private' : 'public',
    topics: [],
    forks: 0,
    open_issues: openIssues,
    watchers: 0,
    default_branch: defaultBranch(repo),
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    delete_branch_on_merge: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
  };
}

function countOpen(repo) {
  let open = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') open += 1;
  for (const pull of repo.pulls.values()) if (pull.state === 'open') open += 1;
  return open;
}

/** Called by the git layer after a push moved refs. */
export function onPush(repo) {
  repo.pushedAt = isoNow();
  repo.epoch += 1;
}

// ------------------------------------------------------------------ commits through the API

function identity(input) {
  const time = Math.floor(Date.now() / 1000);
  if (input && typeof input === 'object' && typeof input.name === 'string' && typeof input.email === 'string') {
    const parsed = typeof input.date === 'string' ? Date.parse(input.date) : NaN;
    return { name: input.name, email: input.email, time: Number.isFinite(parsed) ? Math.floor(parsed / 1000) : time, tz: '+0000' };
  }
  return { name: VIEWER.name, email: VIEWER_EMAIL, time, tz: '+0000' };
}

/**
 * Commit a set of file changes on a branch (creating it from the default branch, or as the first commit of
 * an empty repository). `changes`: [{path, content: Buffer | null}] (null deletes). Returns the commit oid.
 */
export function commitFiles(repo, { branch, changes, message, author, committer }) {
  const git = repo.git;
  const ref = `refs/heads/${branch}`;
  let parent = git.refs.get(ref) ?? null;
  if (parent === null && !git.isEmpty()) parent = git.refs.get(git.head) ?? null;
  const flat = parent ? git.flatten(git.commit(parent).tree) : new Map();
  for (const change of changes) {
    if (change.content === null) flat.delete(change.path);
    else flat.set(change.path, { mode: '100644', oid: git.put('blob', change.content) });
  }
  const tree = git.buildTree(flat);
  const authorIdent = identity(author);
  const commitOid = git.put('commit', serializeCommit({
    tree,
    parents: parent ? [parent] : [],
    author: authorIdent,
    committer: committer ? identity(committer) : authorIdent,
    message: message || 'Update',
  }));
  if (git.isEmpty() && !git.refs.has(git.head)) git.head = ref;
  git.refs.set(ref, commitOid);
  git.touch();
  onPush(repo);
  return commitOid;
}

/** Normalize a contents path: no leading/trailing slash, no empty or dot segments. */
export function cleanPath(path) {
  const clean = String(path ?? '').replace(/^\/+|\/+$/g, '');
  if (clean.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new ForgeError(422, 'path contains a malformed path component', [{ resource: 'Commit', field: 'path', code: 'invalid' }]);
  }
  return clean;
}

/** PUT contents: create (201) or update (200) one file; a stale or missing sha on update is a 409 / 422. */
export function putContents(repo, path, { message, content, sha, branch, author, committer }) {
  const clean = cleanPath(path);
  if (typeof content !== 'string') throw new ForgeError(422, 'Invalid request.\n\n"content" wasn\'t supplied.');
  if (typeof message !== 'string' || message === '') throw new ForgeError(422, 'Invalid request.\n\n"message" wasn\'t supplied.');
  const data = Buffer.from(content.replace(/\s+/g, ''), 'base64');
  const git = repo.git;
  const target = typeof branch === 'string' && branch ? branch : defaultBranch(repo);
  const tip = git.refs.get(`refs/heads/${target}`) ?? (git.isEmpty() ? null : git.refs.get(git.head) ?? null);
  if (!git.isEmpty() && !git.refs.has(`refs/heads/${target}`) && typeof branch === 'string' && branch && tip === null) {
    throw new ForgeError(404, `Branch ${target} not found`);
  }
  const existing = tip ? git.lookupPath(tip, clean) : null;
  if (existing && existing.type === 'tree') throw new ForgeError(422, `${clean} is a directory`);
  if (existing) {
    if (typeof sha !== 'string' || sha === '') throw new ForgeError(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
    if (sha.toLowerCase() !== existing.oid) throw new ForgeError(409, `${clean} does not match ${sha}`);
  } else if (typeof sha === 'string' && sha !== '' && tip) {
    throw new ForgeError(409, `${clean} does not match ${sha}`);
  }
  const commitOid = commitFiles(repo, { branch: target, changes: [{ path: clean, content: data }], message, author, committer });
  const entry = git.lookupPath(commitOid, clean);
  return { created: !existing, commitOid, blobOid: entry.oid, path: clean, size: data.length };
}

export function deleteContents(repo, path, { message, sha, branch, author, committer }) {
  const clean = cleanPath(path);
  const git = repo.git;
  const target = typeof branch === 'string' && branch ? branch : defaultBranch(repo);
  const tip = git.refs.get(`refs/heads/${target}`);
  if (!tip) throw new ForgeError(404, 'Not Found');
  const existing = git.lookupPath(tip, clean);
  if (!existing || existing.type !== 'blob') throw new ForgeError(404, 'Not Found');
  if (typeof sha !== 'string' || sha === '') throw new ForgeError(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
  if (sha.toLowerCase() !== existing.oid) throw new ForgeError(409, `${clean} does not match ${sha}`);
  const commitOid = commitFiles(repo, { branch: target, changes: [{ path: clean, content: null }], message: message || `Delete ${clean}`, author, committer });
  return { commitOid };
}

export function contentEntryJson(repo, origin, path, entry, ref) {
  const full = `${VIEWER.login}/${repo.name}`;
  const name = path.split('/').pop() ?? path;
  const type = entry.type === 'tree' ? 'dir' : entry.mode === '120000' ? 'symlink' : entry.mode === '160000' ? 'submodule' : 'file';
  const size = entry.type === 'blob' ? repo.git.get(entry.oid)?.data.length ?? 0 : 0;
  const url = `${origin}/api/v3/repos/${full}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;
  const gitUrl = `${origin}/api/v3/repos/${full}/git/${entry.type === 'tree' ? 'trees' : 'blobs'}/${entry.oid}`;
  const htmlUrl = `${origin}/${full}/${entry.type === 'tree' ? 'tree' : 'blob'}/${ref || defaultBranch(repo)}/${path}`;
  return {
    type,
    size,
    name,
    path,
    sha: entry.oid,
    url,
    git_url: gitUrl,
    html_url: htmlUrl,
    download_url: type === 'file' ? `${origin}/${full}/raw/${ref || defaultBranch(repo)}/${path}` : null,
    _links: { self: url, git: gitUrl, html: htmlUrl },
  };
}

export function commitJson(repo, origin, oid) {
  const full = `${VIEWER.login}/${repo.name}`;
  const commit = repo.git.commit(oid);
  const date = (ident) => new Date(ident.time * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const api = `${origin}/api/v3/repos/${full}`;
  return {
    sha: oid,
    node_id: nodeIdOf('C', 'Commit', oid),
    commit: {
      author: { name: commit.author.name, email: commit.author.email, date: date(commit.author) },
      committer: { name: commit.committer.name, email: commit.committer.email, date: date(commit.committer) },
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree, url: `${api}/git/trees/${commit.tree}` },
      url: `${api}/git/commits/${oid}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `${api}/commits/${oid}`,
    html_url: `${origin}/${full}/commit/${oid}`,
    comments_url: `${api}/commits/${oid}/comments`,
    author: commit.author.email === VIEWER_EMAIL ? userJson(origin) : null,
    committer: commit.committer.email === VIEWER_EMAIL ? userJson(origin) : null,
    parents: commit.parents.map((parent) => ({ sha: parent, url: `${api}/commits/${parent}`, html_url: `${origin}/${full}/commit/${parent}` })),
  };
}

/** The `commit` object the contents API answers with. */
export function gitCommitJson(repo, origin, oid) {
  const full = `${VIEWER.login}/${repo.name}`;
  const commit = repo.git.commit(oid);
  const date = (ident) => new Date(ident.time * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const api = `${origin}/api/v3/repos/${full}`;
  return {
    sha: oid,
    node_id: nodeIdOf('C', 'Commit', oid),
    url: `${api}/git/commits/${oid}`,
    html_url: `${origin}/${full}/commit/${oid}`,
    author: { name: commit.author.name, email: commit.author.email, date: date(commit.author) },
    committer: { name: commit.committer.name, email: commit.committer.email, date: date(commit.committer) },
    tree: { sha: commit.tree, url: `${api}/git/trees/${commit.tree}` },
    message: commit.message.replace(/\n$/, ''),
    parents: commit.parents.map((parent) => ({ sha: parent, url: `${api}/git/commits/${parent}`, html_url: `${origin}/${full}/commit/${parent}` })),
    verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
  };
}

export function branchJson(repo, origin, name) {
  const full = `${VIEWER.login}/${repo.name}`;
  const sha = repo.git.refs.get(`refs/heads/${name}`);
  return {
    name,
    commit: { sha, url: `${origin}/api/v3/repos/${full}/commits/${sha}` },
    protected: false,
  };
}

export function refJson(repo, origin, ref) {
  const full = `${VIEWER.login}/${repo.name}`;
  const oid = repo.git.refs.get(ref);
  const type = repo.git.get(oid)?.type ?? 'commit';
  return {
    ref,
    node_id: nodeIdOf('REF', 'Ref', `${repo.id}:${ref}`),
    url: `${origin}/api/v3/repos/${full}/git/${ref}`,
    object: { sha: oid, type, url: `${origin}/api/v3/repos/${full}/git/${type}s/${oid}` },
  };
}

// ------------------------------------------------------------------ labels

const LABEL_COLORS = ['d73a4a', 'a2eeef', '0075ca', 'd876e3', '7057ff', '008672', 'e4e669', 'cfd3d7'];

export function createLabel(repo, input) {
  const name = input && typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new ForgeError(422, 'Validation Failed', [{ resource: 'Label', code: 'missing_field', field: 'name' }]);
  if (repo.labels.has(name.toLowerCase())) throw new ForgeError(422, 'Validation Failed', [{ resource: 'Label', code: 'already_exists', field: 'name' }]);
  const id = store.nextLabelId++;
  const color = typeof input.color === 'string' && /^#?[0-9a-fA-F]{6}$/.test(input.color) ? input.color.replace('#', '').toLowerCase() : LABEL_COLORS[id % LABEL_COLORS.length];
  const label = { id, nodeId: nodeIdOf('LA', 'Label', id), name, color, description: typeof input.description === 'string' ? input.description : null };
  repo.labels.set(name.toLowerCase(), label);
  register(label, 'Label', repo);
  repo.epoch += 1;
  return label;
}

export function labelJson(repo, origin, label) {
  return {
    id: label.id,
    node_id: label.nodeId,
    url: `${origin}/api/v3/repos/${VIEWER.login}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

/** Resolve label names (or {name} objects); an unknown one is a 422. */
export function resolveLabels(repo, labels) {
  if (labels === undefined || labels === null) return [];
  if (!Array.isArray(labels)) throw new ForgeError(422, 'Validation Failed', [{ resource: 'Issue', code: 'invalid', field: 'labels' }]);
  const names = [];
  for (const entry of labels) {
    const name = typeof entry === 'string' ? entry : entry && typeof entry.name === 'string' ? entry.name : null;
    const label = name === null ? null : repo.labels.get(name.trim().toLowerCase());
    if (!label) {
      throw new ForgeError(422, 'Validation Failed', [{ resource: 'Label', code: 'invalid', field: 'labels', value: name, message: `Label "${name}" does not exist` }]);
    }
    if (!names.includes(label.name)) names.push(label.name);
  }
  return names;
}

// ------------------------------------------------------------------ issues

export function createIssue(repo, input) {
  const title = input && typeof input.title === 'string' ? input.title : input && typeof input.title === 'number' ? String(input.title) : '';
  if (title.trim() === '') throw new ForgeError(422, 'Validation Failed', [{ resource: 'Issue', code: 'missing_field', field: 'title' }]);
  const labels = resolveLabels(repo, input.labels);
  const now = isoNow();
  const id = store.nextIssueId++;
  const issue = {
    id,
    nodeId: nodeIdOf('I', 'Issue', id),
    number: repo.nextNumber++,
    title,
    body: typeof input.body === 'string' ? input.body : null,
    state: 'open',
    stateReason: null,
    labels,
    assignees: Array.isArray(input.assignees) ? input.assignees.filter(isViewer) : [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: 0,
    seq: ++store.seq,
    updatedSeq: store.seq,
    cache: null,
  };
  repo.issues.set(issue.number, issue);
  register(issue, 'Issue', repo);
  repo.epoch += 1;
  return issue;
}

export function updateIssue(repo, issue, patch) {
  if (patch.title !== undefined) {
    if (typeof patch.title !== 'string' || patch.title.trim() === '') throw new ForgeError(422, 'Validation Failed', [{ resource: 'Issue', code: 'missing_field', field: 'title' }]);
    issue.title = patch.title;
  }
  if (patch.body !== undefined) issue.body = patch.body === null ? null : String(patch.body);
  if (patch.labels !== undefined) issue.labels = resolveLabels(repo, patch.labels);
  if (patch.assignees !== undefined && Array.isArray(patch.assignees)) issue.assignees = patch.assignees.filter(isViewer);
  if (patch.state !== undefined) {
    const state = String(patch.state).toLowerCase();
    if (state !== 'open' && state !== 'closed') throw new ForgeError(422, 'Validation Failed', [{ resource: 'Issue', code: 'invalid', field: 'state' }]);
    if (state !== issue.state) {
      issue.state = state;
      issue.closedAt = state === 'closed' ? isoNow() : null;
      issue.stateReason = state === 'closed' ? (typeof patch.state_reason === 'string' ? patch.state_reason : 'completed') : 'reopened';
    }
  }
  issue.updatedAt = isoNow();
  issue.updatedSeq = ++store.seq;
  issue.cache = null;
  repo.epoch += 1;
  return issue;
}

export function issueJson(repo, issue, origin) {
  const cache = issue.cache;
  if (cache !== null && cache.origin === origin && cache.epoch === repo.epoch && cache.name === repo.name) return cache.json;
  const full = `${VIEWER.login}/${repo.name}`;
  const api = `${origin}/api/v3/repos/${full}`;
  const json = {
    url: `${api}/issues/${issue.number}`,
    repository_url: api,
    labels_url: `${api}/issues/${issue.number}/labels{/name}`,
    comments_url: `${api}/issues/${issue.number}/comments`,
    events_url: `${api}/issues/${issue.number}/events`,
    html_url: `${origin}/${full}/issues/${issue.number}`,
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    user: userJson(origin),
    labels: issue.labels.map((name) => repo.labels.get(name.toLowerCase())).filter(Boolean).map((label) => labelJson(repo, origin, label)),
    state: issue.state,
    locked: false,
    assignee: issue.assignees.length ? userJson(origin) : null,
    assignees: issue.assignees.map(() => userJson(origin)),
    milestone: null,
    comments: issue.comments,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    active_lock_reason: null,
    body: issue.body,
    closed_by: issue.state === 'closed' ? userJson(origin) : null,
    state_reason: issue.stateReason,
    reactions: { url: `${api}/issues/${issue.number}/reactions`, total_count: 0, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
  };
  const text = JSON.stringify(json);
  issue.cache = { origin, epoch: repo.epoch, name: repo.name, json, text };
  return json;
}

/** The issue JSON as serialized text (the hot read path). */
export function issueText(repo, issue, origin) {
  issueJson(repo, issue, origin);
  return issue.cache.text;
}

/** Issues filtered and sorted the way GET /issues takes them. */
export function queryIssues(repo, { state = 'open', sort = 'created', direction = 'desc', labels = null } = {}) {
  const wanted = String(state).toLowerCase();
  let list = [...repo.issues.values()].filter((issue) => wanted === 'all' || issue.state === wanted);
  if (labels) {
    const names = labels.map((name) => name.toLowerCase());
    list = list.filter((issue) => names.every((name) => issue.labels.some((label) => label.toLowerCase() === name)));
  }
  const key = sort === 'updated' ? (issue) => issue.updatedSeq : sort === 'comments' ? (issue) => issue.comments * 1e9 + issue.number : (issue) => issue.number;
  list.sort((a, b) => key(a) - key(b) || a.number - b.number);
  if (String(direction).toLowerCase() !== 'asc') list.reverse();
  return list;
}

// ------------------------------------------------------------------ comments

export function addComment(repo, number, body) {
  if (typeof body !== 'string' || body === '') throw new ForgeError(422, 'Validation Failed', [{ resource: 'IssueComment', code: 'missing_field', field: 'body' }]);
  const target = repo.issues.get(number) ?? repo.pulls.get(number);
  if (!target) throw new ForgeError(404, 'Not Found');
  const now = isoNow();
  const id = store.nextCommentId++;
  const comment = { id, nodeId: nodeIdOf('IC', 'IssueComment', id), number, body, createdAt: now, updatedAt: now };
  if (!repo.comments.has(number)) repo.comments.set(number, []);
  repo.comments.get(number).push(comment);
  register(comment, 'IssueComment', repo);
  target.comments += 1;
  target.updatedAt = now;
  if ('updatedSeq' in target) target.updatedSeq = ++store.seq;
  target.cache = null;
  return comment;
}

export function findComment(repo, id) {
  for (const list of repo.comments.values()) {
    const found = list.find((comment) => comment.id === id);
    if (found) return found;
  }
  return null;
}

export function deleteComment(repo, comment) {
  const list = repo.comments.get(comment.number) ?? [];
  const index = list.indexOf(comment);
  if (index >= 0) list.splice(index, 1);
  const target = repo.issues.get(comment.number) ?? repo.pulls.get(comment.number);
  if (target) { target.comments = Math.max(0, target.comments - 1); target.cache = null; }
  store.nodes.delete(comment.nodeId);
}

export function commentJson(repo, origin, comment) {
  const full = `${VIEWER.login}/${repo.name}`;
  const api = `${origin}/api/v3/repos/${full}`;
  return {
    url: `${api}/issues/comments/${comment.id}`,
    html_url: `${origin}/${full}/issues/${comment.number}#issuecomment-${comment.id}`,
    issue_url: `${api}/issues/${comment.number}`,
    id: comment.id,
    node_id: comment.nodeId,
    user: userJson(origin),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
    body: comment.body,
  };
}

// ------------------------------------------------------------------ pull requests

export function stripOwner(ref) {
  const text = String(ref ?? '');
  const colon = text.indexOf(':');
  return colon >= 0 ? text.slice(colon + 1) : text;
}

export function createPull(repo, input) {
  const title = input && typeof input.title === 'string' ? input.title : '';
  const head = stripOwner(input?.head).replace(/^refs\/heads\//, '');
  const base = String(input?.base ?? defaultBranch(repo)).replace(/^refs\/heads\//, '');
  if (!input?.head || !head) throw new ForgeError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'missing_field', field: 'head' }]);
  if (title.trim() === '') throw new ForgeError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'missing_field', field: 'title' }]);
  const git = repo.git;
  const headSha = git.refs.get(`refs/heads/${head}`);
  const baseSha = git.refs.get(`refs/heads/${base}`);
  if (!headSha) throw new ForgeError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'invalid', field: 'head', message: `head ${head} does not exist` }]);
  if (!baseSha) throw new ForgeError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'invalid', field: 'base', message: `base ${base} does not exist` }]);
  if (head === base) throw new ForgeError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'invalid', field: 'head', message: 'head and base must differ' }]);
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.head === head && pull.base === base) {
      throw new ForgeError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'custom', message: `A pull request already exists for ${VIEWER.login}:${head}.` }]);
    }
  }
  const now = isoNow();
  const id = store.nextPullId++;
  const pull = {
    id,
    nodeId: nodeIdOf('PR', 'PullRequest', id),
    number: repo.nextNumber++,
    title,
    body: typeof input.body === 'string' ? input.body : null,
    state: 'open',
    head,
    base,
    headSha: null,
    baseSha: null,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    draft: input.draft === true,
    labels: [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: 0,
    files: null,
    seq: ++store.seq,
    cache: null,
  };
  repo.pulls.set(pull.number, pull);
  register(pull, 'PullRequest', repo);
  repo.epoch += 1;
  return pull;
}

export function pullTips(repo, pull) {
  if (pull.state !== 'open') return { head: pull.headSha, base: pull.baseSha };
  return {
    head: repo.git.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha,
    base: repo.git.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha,
  };
}

/** Whether an open pull request merges cleanly: true, false, or null when it cannot be computed. */
export function pullMergeable(repo, pull) {
  if (pull.state !== 'open') return null;
  const { head, base } = pullTips(repo, pull);
  if (!head || !base) return null;
  const git = repo.git;
  if (git.isAncestor(base, head) || git.isAncestor(head, base)) return true;
  const mergeBase = git.mergeBase(base, head);
  const result = git.mergeTrees(mergeBase ? git.commit(mergeBase).tree : null, git.commit(base).tree, git.commit(head).tree);
  return !result.conflicts;
}

function countLines(buffer) {
  if (!buffer || buffer.length === 0) return [];
  const text = buffer.toString('utf8');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Added/deleted line counts between two blobs (LCS on lines, bounded). */
function lineDiff(before, after) {
  const a = countLines(before);
  const b = countLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  if (x.length === 0 || y.length === 0) return { additions: y.length, deletions: x.length };
  if (x.length * y.length > 4_000_000) return { additions: y.length, deletions: x.length };
  let prev = new Uint32Array(y.length + 1);
  let next = new Uint32Array(y.length + 1);
  for (let i = 1; i <= x.length; i += 1) {
    for (let j = 1; j <= y.length; j += 1) next[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], next[j - 1]);
    [prev, next] = [next, prev];
  }
  const common = prev[y.length];
  return { additions: y.length - common, deletions: x.length - common };
}

/** The changed files of a pull request (merge base against head), cached once it is closed. */
export function pullFiles(repo, pull) {
  if (pull.files) return pull.files;
  const { head, base } = pullTips(repo, pull);
  if (!head || !base) return [];
  const git = repo.git;
  const mergeBase = git.mergeBase(base, head);
  const before = mergeBase ? git.flatten(git.commit(mergeBase).tree) : new Map();
  const after = git.flatten(git.commit(head).tree);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const files = [];
  for (const path of paths) {
    const old = before.get(path);
    const now = after.get(path);
    if (old && now && old.oid === now.oid && old.mode === now.mode) continue;
    const counts = lineDiff(old ? git.get(old.oid)?.data : null, now ? git.get(now.oid)?.data : null);
    files.push({
      path,
      sha: now ? now.oid : old.oid,
      status: !old ? 'added' : !now ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
    });
  }
  return files;
}

export function pullFileJson(repo, origin, file, headSha) {
  const full = `${VIEWER.login}/${repo.name}`;
  return {
    sha: file.sha,
    filename: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.additions + file.deletions,
    blob_url: `${origin}/${full}/blob/${headSha}/${file.path}`,
    raw_url: `${origin}/${full}/raw/${headSha}/${file.path}`,
    contents_url: `${origin}/api/v3/repos/${full}/contents/${file.path}?ref=${headSha}`,
  };
}

export function closePull(repo, pull) {
  if (pull.state === 'closed') return pull;
  const tips = pullTips(repo, pull);
  pull.files = pullFiles(repo, pull);
  pull.headSha = tips.head;
  pull.baseSha = tips.base;
  pull.state = 'closed';
  pull.closedAt = isoNow();
  pull.updatedAt = pull.closedAt;
  repo.epoch += 1;
  return pull;
}

export function updatePull(repo, pull, patch) {
  if (patch.title !== undefined) pull.title = String(patch.title);
  if (patch.body !== undefined) pull.body = patch.body === null ? null : String(patch.body);
  if (patch.base !== undefined && pull.state === 'open') {
    const base = String(patch.base);
    if (!repo.git.refs.has(`refs/heads/${base}`)) throw new ForgeError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'invalid', field: 'base' }]);
    pull.base = base;
  }
  if (patch.state !== undefined) {
    const state = String(patch.state).toLowerCase();
    if (state === 'closed') closePull(repo, pull);
    else if (state === 'open' && pull.state === 'closed' && !pull.merged) {
      pull.state = 'open';
      pull.closedAt = null;
      pull.files = null;
    }
  }
  pull.updatedAt = isoNow();
  repo.epoch += 1;
  return pull;
}

/**
 * Merge a pull request: squash (one commit with the merged tree), merge (a two-parent merge commit) or
 * rebase (a fast-forward when possible, else one replayed commit). 405 when it cannot merge cleanly.
 */
export function mergePull(repo, pull, { method = 'merge', title, message, sha } = {}) {
  if (pull.merged || pull.state !== 'open') throw new ForgeError(405, 'Pull Request is not mergeable');
  const git = repo.git;
  const head = git.refs.get(`refs/heads/${pull.head}`);
  const base = git.refs.get(`refs/heads/${pull.base}`);
  if (!head || !base) throw new ForgeError(405, 'Pull Request is not mergeable');
  if (typeof sha === 'string' && sha !== '' && sha.toLowerCase() !== head) {
    throw new ForgeError(409, 'Head branch was modified. Review and try the merge again.');
  }
  const mode = String(method || 'merge').toLowerCase();
  if (!['merge', 'squash', 'rebase'].includes(mode)) throw new ForgeError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'invalid', field: 'merge_method' }]);
  const mergeBase = git.mergeBase(base, head);
  const merged = git.mergeTrees(mergeBase ? git.commit(mergeBase).tree : null, git.commit(base).tree, git.commit(head).tree);
  if (merged.conflicts) throw new ForgeError(405, 'Pull Request is not mergeable');
  const files = pullFiles(repo, pull);
  const author = identity(null);
  let newTip;
  if (mode === 'rebase' && git.isAncestor(base, head)) {
    newTip = head;
  } else if (mode === 'merge') {
    const headline = typeof title === 'string' && title ? title : `Merge pull request #${pull.number} from ${VIEWER.login}/${pull.head}`;
    const body = typeof message === 'string' ? message : pull.title;
    newTip = git.put('commit', serializeCommit({ tree: merged.tree, parents: [base, head], author, committer: author, message: body ? `${headline}\n\n${body}` : headline }));
  } else {
    const headline = typeof title === 'string' && title ? title : `${pull.title} (#${pull.number})`;
    const body = typeof message === 'string' ? message : '';
    newTip = git.put('commit', serializeCommit({ tree: merged.tree, parents: [base], author, committer: author, message: body ? `${headline}\n\n${body}` : headline }));
  }
  git.refs.set(`refs/heads/${pull.base}`, newTip);
  git.touch();
  onPush(repo);
  const now = isoNow();
  pull.files = files;
  pull.headSha = head;
  pull.baseSha = base;
  pull.merged = true;
  pull.mergedAt = now;
  pull.mergeCommitSha = newTip;
  pull.state = 'closed';
  pull.closedAt = now;
  pull.updatedAt = now;
  repo.epoch += 1;
  return { sha: newTip, merged: true, message: 'Pull Request successfully merged' };
}

function branchRef(repo, origin, branch, sha) {
  return {
    label: `${VIEWER.login}:${branch}`,
    ref: branch,
    sha: sha ?? ZERO_OID,
    user: userJson(origin),
    repo: repoJson(repo, origin),
  };
}

export function pullCommitCount(repo, pull) {
  const { head, base } = pullTips(repo, pull);
  if (!head) return 0;
  const exclude = base ? repo.git.ancestors(base) : new Set();
  let count = 0;
  for (const oid of repo.git.ancestors(head)) if (!exclude.has(oid)) count += 1;
  return count;
}

export function pullJson(repo, pull, origin, detailed = true) {
  const full = `${VIEWER.login}/${repo.name}`;
  const api = `${origin}/api/v3/repos/${full}`;
  const tips = pullTips(repo, pull);
  const json = {
    url: `${api}/pulls/${pull.number}`,
    id: pull.id,
    node_id: pull.nodeId,
    html_url: `${origin}/${full}/pull/${pull.number}`,
    diff_url: `${origin}/${full}/pull/${pull.number}.diff`,
    patch_url: `${origin}/${full}/pull/${pull.number}.patch`,
    issue_url: `${api}/issues/${pull.number}`,
    commits_url: `${api}/pulls/${pull.number}/commits`,
    comments_url: `${api}/issues/${pull.number}/comments`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userJson(origin),
    body: pull.body,
    labels: pull.labels.map((name) => repo.labels.get(name.toLowerCase())).filter(Boolean).map((label) => labelJson(repo, origin, label)),
    milestone: null,
    active_lock_reason: null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    head: branchRef(repo, origin, pull.head, tips.head),
    base: branchRef(repo, origin, pull.base, tips.base),
    author_association: 'OWNER',
    auto_merge: null,
    draft: pull.draft,
    merged: pull.merged,
  };
  if (detailed) {
    const files = pullFiles(repo, pull);
    const mergeable = pullMergeable(repo, pull);
    json.mergeable = mergeable;
    json.rebaseable = mergeable;
    json.mergeable_state = pull.state !== 'open' ? 'unknown' : mergeable === false ? 'dirty' : 'clean';
    json.merged_by = pull.merged ? userJson(origin) : null;
    json.comments = pull.comments;
    json.review_comments = 0;
    json.maintainer_can_modify = false;
    json.commits = pullCommitCount(repo, pull);
    json.additions = files.reduce((sum, file) => sum + file.additions, 0);
    json.deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    json.changed_files = files.length;
  }
  return json;
}

export function queryPulls(repo, { state = 'open', head = null, base = null, sort = 'created', direction = 'desc' } = {}) {
  const wanted = String(state).toLowerCase();
  let list = [...repo.pulls.values()].filter((pull) => wanted === 'all' || pull.state === wanted);
  if (head) list = list.filter((pull) => pull.head === stripOwner(head));
  if (base) list = list.filter((pull) => pull.base === base);
  list.sort((a, b) => a.number - b.number);
  if (sort === 'updated') list.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.number - b.number));
  if (String(direction).toLowerCase() !== 'asc') list.reverse();
  return list;
}
