// graphql.ts: GitHub's GraphQL v4 surface for the documents gh and github-mcp-server send. A small
// GraphQL implementation: a lexer and parser (operations, variables, fragments, inline fragments,
// directives, every literal kind), a validator that names unknown fields, an executor over a typed
// schema, and introspection (__type, __schema, __typename). Data comes from forge.ts, the same store
// REST and MCP use.

import * as F from './forge.ts';

// ------------------------------------------------------------------ lexer

const PUNCT = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}']);

class GraphQLError extends Error {
  constructor(message, extra) {
    super(message);
    this.extra = extra;
  }
}

function lex(source) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === '\n') { i += 1; line += 1; lineStart = i; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === ',' || ch === '\ufeff') { i += 1; continue; }
    if (ch === '#') { while (i < n && source[i] !== '\n') i += 1; continue; }
    const loc = { line, column: i - lineStart + 1 };
    if (ch === '.' && source.startsWith('...', i)) { tokens.push({ kind: '...', value: '...', loc }); i += 3; continue; }
    if (PUNCT.has(ch)) { tokens.push({ kind: ch, value: ch, loc }); i += 1; continue; }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[_0-9A-Za-z]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j), loc });
      i = j;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const match = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(i, i + 64));
      if (!match) throw new GraphQLError(`Parse error on "${ch}" at [${loc.line}, ${loc.column}]`);
      tokens.push({ kind: match[2] || match[3] ? 'float' : 'int', value: match[0], loc });
      i += match[0].length;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new GraphQLError('Parse error: unterminated block string');
        const raw = source.slice(i + 3, end).replace(/\\"""/g, '"""');
        tokens.push({ kind: 'string', value: blockString(raw), loc });
        for (let k = i; k < end; k += 1) if (source[k] === '\n') { line += 1; lineStart = k + 1; }
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < n && source[j] !== '"') {
        if (source[j] === '\n') throw new GraphQLError('Parse error: unterminated string');
        if (source[j] === '\\') {
          const esc = source[j + 1];
          if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
            continue;
          }
          value += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }[esc] ?? esc;
          j += 2;
          continue;
        }
        value += source[j];
        j += 1;
      }
      if (j >= n) throw new GraphQLError('Parse error: unterminated string');
      tokens.push({ kind: 'string', value, loc });
      i = j + 1;
      continue;
    }
    throw new GraphQLError(`Parse error on "${ch}" at [${loc.line}, ${loc.column}]`);
  }
  tokens.push({ kind: 'eof', value: '', loc: { line, column: i - lineStart + 1 } });
  return tokens;
}

function blockString(raw) {
  const lines = raw.split(/\r\n|\n|\r/);
  let common = null;
  for (let index = 1; index < lines.length; index += 1) {
    const indent = lines[index].length - lines[index].trimStart().length;
    if (indent < lines[index].length && (common === null || indent < common)) common = indent;
  }
  if (common) for (let index = 1; index < lines.length; index += 1) lines[index] = lines[index].slice(common);
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

// ------------------------------------------------------------------ parser

function parse(source) {
  const tokens = lex(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const fail = (token) => {
    throw new GraphQLError(`Parse error on ${token.kind === 'eof' ? 'end of file' : JSON.stringify(token.value)} at [${token.loc.line}, ${token.loc.column}]`);
  };
  const expect = (kind) => {
    const token = next();
    if (token.kind !== kind) fail(token);
    return token;
  };
  const isName = (value) => peek().kind === 'name' && (value === undefined || peek().value === value);

  const parseValue = (constant) => {
    const token = peek();
    if (token.kind === '$' && !constant) {
      next();
      return { kind: 'Variable', name: expect('name').value };
    }
    if (token.kind === 'int') { next(); return { kind: 'Int', value: parseInt(token.value, 10) }; }
    if (token.kind === 'float') { next(); return { kind: 'Float', value: parseFloat(token.value) }; }
    if (token.kind === 'string') { next(); return { kind: 'String', value: token.value }; }
    if (token.kind === 'name') {
      next();
      if (token.value === 'true') return { kind: 'Boolean', value: true };
      if (token.value === 'false') return { kind: 'Boolean', value: false };
      if (token.value === 'null') return { kind: 'Null', value: null };
      return { kind: 'Enum', value: token.value };
    }
    if (token.kind === '[') {
      next();
      const values = [];
      while (peek().kind !== ']') { if (peek().kind === 'eof') fail(peek()); values.push(parseValue(constant)); }
      next();
      return { kind: 'List', values };
    }
    if (token.kind === '{') {
      next();
      const fields = [];
      while (peek().kind !== '}') {
        if (peek().kind === 'eof') fail(peek());
        const name = expect('name').value;
        expect(':');
        fields.push({ name, value: parseValue(constant) });
      }
      next();
      return { kind: 'Object', fields };
    }
    return fail(token);
  };

  const parseArguments = () => {
    const args = [];
    if (peek().kind !== '(') return args;
    next();
    while (peek().kind !== ')') {
      const name = expect('name').value;
      expect(':');
      args.push({ name, value: parseValue(false) });
    }
    next();
    return args;
  };

  const parseDirectives = () => {
    const directives = [];
    while (peek().kind === '@') {
      next();
      directives.push({ name: expect('name').value, arguments: parseArguments() });
    }
    return directives;
  };

  const parseType = () => {
    let type;
    if (peek().kind === '[') {
      next();
      type = `[${parseType()}]`;
      expect(']');
    } else {
      type = expect('name').value;
    }
    if (peek().kind === '!') { next(); type += '!'; }
    return type;
  };

  const parseSelectionSet = () => {
    expect('{');
    const selections = [];
    while (peek().kind !== '}') {
      if (peek().kind === 'eof') fail(peek());
      if (peek().kind === '...') {
        const loc = next().loc;
        if (isName('on')) {
          next();
          const typeCondition = expect('name').value;
          selections.push({ kind: 'InlineFragment', typeCondition, directives: parseDirectives(), selectionSet: parseSelectionSet(), loc });
        } else if (peek().kind === 'name') {
          selections.push({ kind: 'FragmentSpread', name: next().value, directives: parseDirectives(), loc });
        } else {
          selections.push({ kind: 'InlineFragment', typeCondition: null, directives: parseDirectives(), selectionSet: parseSelectionSet(), loc });
        }
        continue;
      }
      const first = expect('name');
      let alias = null;
      let name = first.value;
      if (peek().kind === ':') {
        next();
        alias = name;
        name = expect('name').value;
      }
      const args = parseArguments();
      const directives = parseDirectives();
      const selectionSet = peek().kind === '{' ? parseSelectionSet() : null;
      selections.push({ kind: 'Field', alias, name, arguments: args, directives, selectionSet, loc: first.loc });
    }
    next();
    return selections;
  };

  const operations = [];
  const fragments = new Map();
  while (peek().kind !== 'eof') {
    if (peek().kind === '{') {
      operations.push({ operation: 'query', name: null, variables: [], directives: [], selectionSet: parseSelectionSet() });
      continue;
    }
    const keyword = expect('name');
    if (keyword.value === 'fragment') {
      const name = expect('name').value;
      if (!isName('on')) fail(peek());
      next();
      const typeCondition = expect('name').value;
      const directives = parseDirectives();
      fragments.set(name, { name, typeCondition, directives, selectionSet: parseSelectionSet() });
      continue;
    }
    if (keyword.value !== 'query' && keyword.value !== 'mutation' && keyword.value !== 'subscription') fail(keyword);
    const name = isName() ? next().value : null;
    const variables = [];
    if (peek().kind === '(') {
      next();
      while (peek().kind !== ')') {
        expect('$');
        const varName = expect('name').value;
        expect(':');
        const type = parseType();
        let defaultValue;
        if (peek().kind === '=') { next(); defaultValue = parseValue(true); }
        parseDirectives();
        variables.push({ name: varName, type, defaultValue });
      }
      next();
    }
    const directives = parseDirectives();
    operations.push({ operation: keyword.value, name, variables, directives, selectionSet: parseSelectionSet() });
  }
  if (operations.length === 0) throw new GraphQLError('No operations given');
  return { operations, fragments };
}

// ------------------------------------------------------------------ schema helpers

function nameOf(type) {
  return type.replace(/[[\]!]/g, '');
}

const VIEWER_NODE = Object.freeze({ __typename: 'User' });

function wrap(entry) {
  if (!entry) return null;
  if (entry.kind === 'Repository') return entry.item;
  return { __typename: entry.kind, repo: entry.repo, item: entry.item };
}

function typeOfValue(value) {
  if (value && typeof value === 'object') {
    if (value.__typename) return value.__typename;
    if (value.git && value.issues) return 'Repository';
  }
  return null;
}

function encodeCursor(index) {
  return Buffer.from(`cursor:v2:${index}`).toString('base64');
}

function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor === '') return null;
  const text = Buffer.from(cursor, 'base64').toString('utf8');
  const match = /^cursor:v2:(\d+)$/.exec(text);
  if (!match) throw new GraphQLError(`\`${cursor}\` does not appear to be a valid cursor.`);
  return Number(match[1]);
}

/** A Relay connection over `list` with first/last/after/before. */
function connection(list, args, map = (item) => item) {
  const total = list.length;
  let start = 0;
  let end = total;
  const after = decodeCursor(args.after ?? null);
  const before = decodeCursor(args.before ?? null);
  if (after !== null) start = Math.max(start, after + 1);
  if (before !== null) end = Math.min(end, before);
  if (typeof args.first === 'number') {
    if (args.first < 0) throw new GraphQLError('`first` must be a non-negative integer');
    end = Math.min(end, start + Math.min(args.first, 100));
  }
  if (typeof args.last === 'number') {
    if (args.last < 0) throw new GraphQLError('`last` must be a non-negative integer');
    start = Math.max(start, end - Math.min(args.last, 100));
  }
  if (args.first === undefined && args.last === undefined && end - start > 100) end = start + 100;
  const slice = [];
  for (let index = start; index < end; index += 1) slice.push({ cursor: encodeCursor(index), node: map(list[index]) });
  return {
    __typename: 'Connection',
    totalCount: total,
    nodes: slice.map((edge) => edge.node),
    edges: slice.map((edge) => ({ __typename: 'Edge', cursor: edge.cursor, node: edge.node })),
    pageInfo: {
      hasNextPage: end < total,
      hasPreviousPage: start > 0,
      startCursor: slice.length ? slice[0].cursor : null,
      endCursor: slice.length ? slice[slice.length - 1].cursor : null,
    },
  };
}

function ts(seconds) {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function commitValue(repo, oid) {
  if (!oid || !repo.git.commit(oid)) return null;
  return { __typename: 'Commit', repo, oid };
}

function refValue(repo, fullName) {
  if (!repo.git.refs.has(fullName)) return null;
  return { __typename: 'Ref', repo, name: fullName };
}

function sortIssues(list, orderBy, defaultDirection = 'ASC') {
  const field = orderBy && typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = orderBy && typeof orderBy.direction === 'string' ? orderBy.direction : defaultDirection;
  const key = field === 'UPDATED_AT' ? (item) => item.updatedSeq ?? item.seq : field === 'COMMENTS' ? (item) => item.comments : (item) => item.seq ?? item.number;
  const sorted = [...list].sort((a, b) => key(a) - key(b) || a.number - b.number);
  if (direction === 'DESC') sorted.reverse();
  return sorted;
}

function statesFilter(states) {
  if (states === undefined || states === null) return null;
  return new Set((Array.isArray(states) ? states : [states]).map((state) => String(state).toUpperCase()));
}

function pullState(pull) {
  return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function needRepo(id) {
  const entry = F.lookupNode(id);
  if (!entry || entry.kind !== 'Repository') throw new GraphQLError(`Could not resolve to a node with the global id of '${id}'`, { type: 'NOT_FOUND' });
  return entry.item;
}

function needNode(id, kinds) {
  const entry = F.lookupNode(id);
  if (!entry || !kinds.includes(entry.kind)) throw new GraphQLError(`Could not resolve to a node with the global id of '${id}'`, { type: 'NOT_FOUND' });
  return entry;
}

function input(args) {
  const value = args.input;
  if (!value || typeof value !== 'object') throw new GraphQLError('Argument \'input\' on Field is required', { type: 'ARGUMENT_MISSING' });
  return value;
}

function labelNames(repo, ids) {
  if (!Array.isArray(ids)) return undefined;
  return ids.map((id) => {
    const entry = F.lookupNode(id);
    if (!entry || entry.kind !== 'Label' || entry.repo !== repo) throw new GraphQLError(`Could not resolve to a node with the global id of '${id}'`, { type: 'NOT_FOUND' });
    return entry.item.name;
  });
}

// ------------------------------------------------------------------ the schema

const CONN_ARGS = { first: 'Int', last: 'Int', after: 'String', before: 'String' };
const SCALARS = ['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'GitObjectID', 'HTML', 'GitTimestamp', 'Date'];

function connectionTypes(name, nodeType) {
  return {
    [`${name}Connection`]: {
      kind: 'OBJECT',
      description: `The connection type for ${nodeType}.`,
      fields: {
        nodes: { type: `[${nodeType}]` },
        edges: { type: `[${name}Edge]` },
        pageInfo: { type: 'PageInfo!' },
        totalCount: { type: 'Int!' },
      },
    },
    [`${name}Edge`]: {
      kind: 'OBJECT',
      description: 'An edge in a connection.',
      fields: { cursor: { type: 'String!' }, node: { type: nodeType } },
    },
  };
}

const actorFields = {
  login: { type: 'String!', resolve: () => F.VIEWER.login },
  avatarUrl: { type: 'URI!', args: { size: 'Int' }, resolve: (_, a, ctx) => `${ctx.origin}/avatars/${F.VIEWER.login}` },
  url: { type: 'URI!', resolve: (_, a, ctx) => `${ctx.origin}/${F.VIEWER.login}` },
  resourcePath: { type: 'URI!', resolve: () => `/${F.VIEWER.login}` },
};

function repoIssueList(repo, args) {
  const states = statesFilter(args.states);
  let list = [...repo.issues.values()];
  if (states) list = list.filter((issue) => states.has(issue.state.toUpperCase()));
  if (Array.isArray(args.labels) && args.labels.length) {
    const wanted = args.labels.map((name) => String(name).toLowerCase());
    list = list.filter((issue) => issue.labels.some((label) => wanted.includes(label.toLowerCase())));
  }
  const filterBy = args.filterBy && typeof args.filterBy === 'object' ? args.filterBy : null;
  if (filterBy && Array.isArray(filterBy.states)) {
    const filterStates = statesFilter(filterBy.states);
    list = list.filter((issue) => filterStates.has(issue.state.toUpperCase()));
  }
  if (filterBy && Array.isArray(filterBy.labels) && filterBy.labels.length) {
    const wanted = filterBy.labels.map((name) => String(name).toLowerCase());
    list = list.filter((issue) => issue.labels.some((label) => wanted.includes(label.toLowerCase())));
  }
  return sortIssues(list, args.orderBy);
}

function repoPullList(repo, args) {
  const states = statesFilter(args.states);
  let list = [...repo.pulls.values()];
  if (states) list = list.filter((pull) => states.has(pullState(pull)));
  if (typeof args.headRefName === 'string') list = list.filter((pull) => pull.head === args.headRefName);
  if (typeof args.baseRefName === 'string') list = list.filter((pull) => pull.base === args.baseRefName);
  return sortIssues(list, args.orderBy);
}

function issueLike(kind) {
  return {
    id: { type: 'ID!', resolve: (v) => v.item.nodeId },
    databaseId: { type: 'Int', resolve: (v) => v.item.id },
    fullDatabaseId: { type: 'String', resolve: (v) => String(v.item.id) },
    number: { type: 'Int!', resolve: (v) => v.item.number },
    title: { type: 'String!', resolve: (v) => v.item.title },
    body: { type: 'String!', resolve: (v) => v.item.body ?? '' },
    bodyText: { type: 'String!', resolve: (v) => v.item.body ?? '' },
    bodyHTML: { type: 'HTML!', resolve: (v) => v.item.body ?? '' },
    closed: { type: 'Boolean!', resolve: (v) => v.item.state !== 'open' },
    closedAt: { type: 'DateTime', resolve: (v) => v.item.closedAt },
    createdAt: { type: 'DateTime!', resolve: (v) => v.item.createdAt },
    updatedAt: { type: 'DateTime!', resolve: (v) => v.item.updatedAt },
    lastEditedAt: { type: 'DateTime', resolve: () => null },
    url: { type: 'URI!', resolve: (v, a, ctx) => `${ctx.origin}/${F.VIEWER.login}/${v.repo.name}/${kind === 'Issue' ? 'issues' : 'pull'}/${v.item.number}` },
    resourcePath: { type: 'URI!', resolve: (v) => `/${F.VIEWER.login}/${v.repo.name}/${kind === 'Issue' ? 'issues' : 'pull'}/${v.item.number}` },
    author: { type: 'Actor', resolve: () => VIEWER_NODE },
    editor: { type: 'Actor', resolve: () => null },
    authorAssociation: { type: 'CommentAuthorAssociation!', resolve: () => 'OWNER' },
    repository: { type: 'Repository!', resolve: (v) => v.repo },
    locked: { type: 'Boolean!', resolve: () => false },
    milestone: { type: 'Milestone', resolve: () => null },
    viewerCanUpdate: { type: 'Boolean!', resolve: () => true },
    viewerDidAuthor: { type: 'Boolean!', resolve: () => true },
    labels: {
      type: 'LabelConnection',
      args: { ...CONN_ARGS, orderBy: 'LabelOrder' },
      resolve: (v, a) => connection(v.item.labels.map((name) => v.repo.labels.get(name.toLowerCase())).filter(Boolean), a, (label) => ({ __typename: 'Label', repo: v.repo, item: label })),
    },
    comments: {
      type: 'IssueCommentConnection!',
      args: { ...CONN_ARGS, orderBy: 'IssueCommentOrder' },
      resolve: (v, a) => connection(v.repo.comments.get(v.item.number) ?? [], a, (comment) => ({ __typename: 'IssueComment', repo: v.repo, item: comment })),
    },
    assignees: { type: 'UserConnection!', args: CONN_ARGS, resolve: (v, a) => connection((v.item.assignees ?? []).map(() => VIEWER_NODE), a) },
    participants: { type: 'UserConnection!', args: CONN_ARGS, resolve: (v, a) => connection([VIEWER_NODE], a) },
    reactionGroups: { type: '[ReactionGroup!]', resolve: () => [] },
    projectCards: { type: 'ProjectCardConnection!', args: CONN_ARGS, resolve: (v, a) => connection([], a) },
    projectItems: { type: 'ProjectV2ItemConnection!', args: CONN_ARGS, resolve: (v, a) => connection([], a) },
  };
}

const enumType = (description, values) => ({ kind: 'ENUM', description, values });
const inputType = (description, fields) => ({ kind: 'INPUT_OBJECT', description, inputFields: fields });

const TYPES = {
  Query: {
    kind: 'OBJECT',
    description: 'The query root of GitHub\'s GraphQL interface.',
    fields: {
      viewer: { type: 'User!', description: 'The currently authenticated user.', resolve: () => VIEWER_NODE },
      user: { type: 'User', args: { login: 'String!' }, resolve: (_, a) => (F.isViewer(a.login) ? VIEWER_NODE : null) },
      repositoryOwner: { type: 'RepositoryOwner', args: { login: 'String!' }, resolve: (_, a) => (F.isViewer(a.login) ? VIEWER_NODE : null) },
      repository: {
        type: 'Repository',
        description: 'Lookup a given repository by the owner and repository name.',
        args: { owner: 'String!', name: 'String!', followRenames: 'Boolean' },
        resolve: (_, a) => F.getRepo(a.owner, a.name),
      },
      node: {
        type: 'Node',
        args: { id: 'ID!' },
        resolve: (_, a) => (a.id === F.nodeIdOf('U', 'User', F.VIEWER.id) ? VIEWER_NODE : wrap(F.lookupNode(a.id))),
      },
      nodes: {
        type: '[Node]!',
        args: { ids: '[ID!]!' },
        resolve: (_, a) => (Array.isArray(a.ids) ? a.ids : []).map((id) => (id === F.nodeIdOf('U', 'User', F.VIEWER.id) ? VIEWER_NODE : wrap(F.lookupNode(id)))),
      },
      rateLimit: {
        type: 'RateLimit',
        args: { dryRun: 'Boolean' },
        resolve: () => ({ limit: 5000, cost: 1, remaining: 4999, used: 1, nodeCount: 1, resetAt: new Date(Date.now() + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z') }),
      },
      search: {
        type: 'SearchResultItemConnection!',
        args: { query: 'String!', type: 'SearchType!', ...CONN_ARGS },
        resolve: (_, a) => search(a),
      },
      meta: { type: 'GitHubMetadata!', resolve: () => ({ installedVersion: F.INSTALLED_VERSION, isPasswordAuthenticationVerifiable: false }) },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    description: 'The root query for implementing GraphQL mutations.',
    fields: {
      createIssue: {
        type: 'CreateIssuePayload',
        args: { input: 'CreateIssueInput!' },
        resolve: (_, a) => {
          const data = input(a);
          const repo = needRepo(data.repositoryId);
          const issue = F.createIssue(repo, { title: data.title, body: data.body, labels: labelNames(repo, data.labelIds) });
          return { clientMutationId: data.clientMutationId ?? null, issue: { __typename: 'Issue', repo, item: issue } };
        },
      },
      updateIssue: {
        type: 'UpdateIssuePayload',
        args: { input: 'UpdateIssueInput!' },
        resolve: (_, a) => {
          const data = input(a);
          const entry = needNode(data.id, ['Issue']);
          const patch = {};
          if (data.title !== undefined) patch.title = data.title;
          if (data.body !== undefined) patch.body = data.body;
          if (data.state !== undefined) patch.state = String(data.state).toLowerCase();
          const labels = labelNames(entry.repo, data.labelIds);
          if (labels) patch.labels = labels;
          F.updateIssue(entry.repo, entry.item, patch);
          return { clientMutationId: data.clientMutationId ?? null, issue: wrap(entry) };
        },
      },
      closeIssue: {
        type: 'CloseIssuePayload',
        args: { input: 'CloseIssueInput!' },
        resolve: (_, a) => {
          const data = input(a);
          const entry = needNode(data.issueId, ['Issue']);
          F.updateIssue(entry.repo, entry.item, { state: 'closed', state_reason: data.stateReason === 'NOT_PLANNED' ? 'not_planned' : 'completed' });
          return { clientMutationId: data.clientMutationId ?? null, issue: wrap(entry) };
        },
      },
      reopenIssue: {
        type: 'ReopenIssuePayload',
        args: { input: 'ReopenIssueInput!' },
        resolve: (_, a) => {
          const data = input(a);
          const entry = needNode(data.issueId, ['Issue']);
          F.updateIssue(entry.repo, entry.item, { state: 'open' });
          return { clientMutationId: data.clientMutationId ?? null, issue: wrap(entry) };
        },
      },
      addComment: {
        type: 'AddCommentPayload',
        args: { input: 'AddCommentInput!' },
        resolve: (_, a) => {
          const data = input(a);
          const entry = needNode(data.subjectId, ['Issue', 'PullRequest']);
          const comment = F.addComment(entry.repo, entry.item.number, data.body);
          const node = { __typename: 'IssueComment', repo: entry.repo, item: comment };
          const index = (entry.repo.comments.get(entry.item.number) ?? []).length - 1;
          return {
            clientMutationId: data.clientMutationId ?? null,
            commentEdge: { cursor: encodeCursor(index), node },
            subject: wrap(entry),
            timelineEdge: { cursor: encodeCursor(index), node },
          };
        },
      },
      createPullRequest: {
        type: 'CreatePullRequestPayload',
        args: { input: 'CreatePullRequestInput!' },
        resolve: (_, a) => {
          const data = input(a);
          const repo = needRepo(data.repositoryId);
          const pull = F.createPull(repo, { title: data.title, body: data.body, head: data.headRefName, base: data.baseRefName, draft: data.draft === true });
          return { clientMutationId: data.clientMutationId ?? null, pullRequest: { __typename: 'PullRequest', repo, item: pull } };
        },
      },
      mergePullRequest: {
        type: 'MergePullRequestPayload',
        args: { input: 'MergePullRequestInput!' },
        resolve: (_, a) => {
          const data = input(a);
          const entry = needNode(data.pullRequestId, ['PullRequest']);
          F.mergePull(entry.repo, entry.item, {
            method: typeof data.mergeMethod === 'string' ? data.mergeMethod.toLowerCase() : 'merge',
            title: data.commitHeadline,
            message: data.commitBody,
            sha: data.expectedHeadOid,
          });
          return { clientMutationId: data.clientMutationId ?? null, pullRequest: wrap(entry) };
        },
      },
      closePullRequest: {
        type: 'ClosePullRequestPayload',
        args: { input: 'ClosePullRequestInput!' },
        resolve: (_, a) => {
          const data = input(a);
          const entry = needNode(data.pullRequestId, ['PullRequest']);
          F.updatePull(entry.repo, entry.item, { state: 'closed' });
          return { clientMutationId: data.clientMutationId ?? null, pullRequest: wrap(entry) };
        },
      },
      reopenPullRequest: {
        type: 'ReopenPullRequestPayload',
        args: { input: 'ReopenPullRequestInput!' },
        resolve: (_, a) => {
          const data = input(a);
          const entry = needNode(data.pullRequestId, ['PullRequest']);
          F.updatePull(entry.repo, entry.item, { state: 'open' });
          return { clientMutationId: data.clientMutationId ?? null, pullRequest: wrap(entry) };
        },
      },
      updatePullRequest: {
        type: 'UpdatePullRequestPayload',
        args: { input: 'UpdatePullRequestInput!' },
        resolve: (_, a) => {
          const data = input(a);
          const entry = needNode(data.pullRequestId, ['PullRequest']);
          const patch = {};
          if (data.title !== undefined) patch.title = data.title;
          if (data.body !== undefined) patch.body = data.body;
          if (data.baseRefName !== undefined) patch.base = data.baseRefName;
          if (data.state !== undefined) patch.state = String(data.state).toLowerCase();
          F.updatePull(entry.repo, entry.item, patch);
          return { clientMutationId: data.clientMutationId ?? null, pullRequest: wrap(entry) };
        },
      },
      createRepository: {
        type: 'CreateRepositoryPayload',
        args: { input: 'CreateRepositoryInput!' },
        resolve: (_, a) => {
          const data = input(a);
          const repo = F.createRepo({ name: data.name, description: data.description, homepage: data.homepageUrl, private: String(data.visibility ?? '').toUpperCase() === 'PRIVATE', has_issues: data.hasIssuesEnabled });
          return { clientMutationId: data.clientMutationId ?? null, repository: repo };
        },
      },
      addLabelsToLabelable: {
        type: 'AddLabelsToLabelablePayload',
        args: { input: 'AddLabelsToLabelableInput!' },
        resolve: (_, a) => {
          const data = input(a);
          const entry = needNode(data.labelableId, ['Issue', 'PullRequest']);
          const names = labelNames(entry.repo, data.labelIds) ?? [];
          entry.item.labels = [...new Set([...entry.item.labels, ...names])];
          entry.item.cache = null;
          entry.repo.epoch += 1;
          return { clientMutationId: data.clientMutationId ?? null, labelable: wrap(entry) };
        },
      },
    },
  },
  User: {
    kind: 'OBJECT',
    description: 'A user is an individual\'s account on GitHub.',
    interfaces: ['Node', 'Actor', 'RepositoryOwner'],
    fields: {
      id: { type: 'ID!', resolve: () => F.nodeIdOf('U', 'User', F.VIEWER.id) },
      databaseId: { type: 'Int', resolve: () => F.VIEWER.id },
      name: { type: 'String', resolve: () => F.VIEWER.name },
      email: { type: 'String!', resolve: () => F.VIEWER_EMAIL },
      bio: { type: 'String', resolve: () => null },
      company: { type: 'String', resolve: () => null },
      createdAt: { type: 'DateTime!', resolve: () => '2024-01-01T00:00:00Z' },
      isSiteAdmin: { type: 'Boolean!', resolve: () => false },
      ...actorFields,
      repositories: {
        type: 'RepositoryConnection!',
        args: { ...CONN_ARGS, privacy: 'RepositoryPrivacy', ownerAffiliations: '[RepositoryAffiliation]', orderBy: 'RepositoryOrder', isFork: 'Boolean' },
        resolve: (_, a) => {
          let list = F.listRepos();
          if (a.privacy === 'PUBLIC') list = list.filter((repo) => !repo.private);
          if (a.privacy === 'PRIVATE') list = list.filter((repo) => repo.private);
          list.sort((x, y) => x.id - y.id);
          return connection(list, a);
        },
      },
      repository: { type: 'Repository', args: { name: 'String!' }, resolve: (_, a) => F.getRepo(F.VIEWER.login, a.name) },
    },
  },
  Repository: {
    kind: 'OBJECT',
    description: 'A repository contains the content for a project.',
    interfaces: ['Node', 'RepositoryInfo'],
    fields: {
      id: { type: 'ID!', resolve: (r) => r.nodeId },
      databaseId: { type: 'Int', resolve: (r) => r.id },
      name: { type: 'String!', resolve: (r) => r.name },
      nameWithOwner: { type: 'String!', resolve: (r) => `${F.VIEWER.login}/${r.name}` },
      owner: { type: 'RepositoryOwner!', resolve: () => VIEWER_NODE },
      description: { type: 'String', resolve: (r) => r.description },
      homepageUrl: { type: 'URI', resolve: (r) => r.homepage },
      url: { type: 'URI!', resolve: (r, a, ctx) => `${ctx.origin}/${F.VIEWER.login}/${r.name}` },
      sshUrl: { type: 'GitSSHRemote!', resolve: (r) => `git@forge:${F.VIEWER.login}/${r.name}.git` },
      resourcePath: { type: 'URI!', resolve: (r) => `/${F.VIEWER.login}/${r.name}` },
      isPrivate: { type: 'Boolean!', resolve: (r) => r.private },
      visibility: { type: 'RepositoryVisibility!', resolve: (r) => (r.private ? 'PRIVATE' : 'PUBLIC') },
      isFork: { type: 'Boolean!', resolve: () => false },
      isArchived: { type: 'Boolean!', resolve: () => false },
      isTemplate: { type: 'Boolean!', resolve: () => false },
      isMirror: { type: 'Boolean!', resolve: () => false },
      isLocked: { type: 'Boolean!', resolve: () => false },
      isDisabled: { type: 'Boolean!', resolve: () => false },
      isEmpty: { type: 'Boolean!', resolve: (r) => r.git.isEmpty() },
      isInOrganization: { type: 'Boolean!', resolve: () => false },
      createdAt: { type: 'DateTime!', resolve: (r) => r.createdAt },
      updatedAt: { type: 'DateTime!', resolve: (r) => r.updatedAt },
      pushedAt: { type: 'DateTime', resolve: (r) => r.pushedAt },
      defaultBranchRef: { type: 'Ref', resolve: (r) => refValue(r, r.git.head) },
      viewerPermission: { type: 'RepositoryPermission', resolve: () => 'ADMIN' },
      viewerCanAdminister: { type: 'Boolean!', resolve: () => true },
      viewerHasStarred: { type: 'Boolean!', resolve: () => false },
      viewerSubscription: { type: 'SubscriptionState', resolve: () => 'SUBSCRIBED' },
      hasIssuesEnabled: { type: 'Boolean!', resolve: (r) => r.hasIssues },
      hasWikiEnabled: { type: 'Boolean!', resolve: (r) => r.hasWiki },
      hasProjectsEnabled: { type: 'Boolean!', resolve: (r) => r.hasProjects },
      hasDiscussionsEnabled: { type: 'Boolean!', resolve: () => false },
      mergeCommitAllowed: { type: 'Boolean!', resolve: () => true },
      squashMergeAllowed: { type: 'Boolean!', resolve: () => true },
      rebaseMergeAllowed: { type: 'Boolean!', resolve: () => true },
      deleteBranchOnMerge: { type: 'Boolean!', resolve: () => false },
      autoMergeAllowed: { type: 'Boolean!', resolve: () => false },
      stargazerCount: { type: 'Int!', resolve: () => 0 },
      forkCount: { type: 'Int!', resolve: () => 0 },
      diskUsage: { type: 'Int', resolve: () => 0 },
      parent: { type: 'Repository', resolve: () => null },
      primaryLanguage: { type: 'Language', resolve: () => null },
      issue: {
        type: 'Issue',
        args: { number: 'Int!' },
        resolve: (r, a) => {
          const issue = r.issues.get(a.number);
          return issue ? { __typename: 'Issue', repo: r, item: issue } : null;
        },
      },
      issueOrPullRequest: {
        type: 'IssueOrPullRequest',
        args: { number: 'Int!' },
        resolve: (r, a) => {
          const issue = r.issues.get(a.number);
          if (issue) return { __typename: 'Issue', repo: r, item: issue };
          const pull = r.pulls.get(a.number);
          return pull ? { __typename: 'PullRequest', repo: r, item: pull } : null;
        },
      },
      issues: {
        type: 'IssueConnection!',
        args: { ...CONN_ARGS, states: '[IssueState!]', orderBy: 'IssueOrder', labels: '[String!]', filterBy: 'IssueFilters' },
        resolve: (r, a) => connection(repoIssueList(r, a), a, (issue) => ({ __typename: 'Issue', repo: r, item: issue })),
      },
      pullRequest: {
        type: 'PullRequest',
        args: { number: 'Int!' },
        resolve: (r, a) => {
          const pull = r.pulls.get(a.number);
          return pull ? { __typename: 'PullRequest', repo: r, item: pull } : null;
        },
      },
      pullRequests: {
        type: 'PullRequestConnection!',
        args: { ...CONN_ARGS, states: '[PullRequestState!]', headRefName: 'String', baseRefName: 'String', orderBy: 'IssueOrder', labels: '[String!]' },
        resolve: (r, a) => connection(repoPullList(r, a), a, (pull) => ({ __typename: 'PullRequest', repo: r, item: pull })),
      },
      label: {
        type: 'Label',
        args: { name: 'String!' },
        resolve: (r, a) => {
          const label = r.labels.get(String(a.name).toLowerCase());
          return label ? { __typename: 'Label', repo: r, item: label } : null;
        },
      },
      labels: {
        type: 'LabelConnection',
        args: { ...CONN_ARGS, query: 'String', orderBy: 'LabelOrder' },
        resolve: (r, a) => {
          let list = [...r.labels.values()].sort((x, y) => x.id - y.id);
          if (typeof a.query === 'string' && a.query) list = list.filter((label) => label.name.toLowerCase().includes(a.query.toLowerCase()));
          return connection(list, a, (label) => ({ __typename: 'Label', repo: r, item: label }));
        },
      },
      ref: {
        type: 'Ref',
        args: { qualifiedName: 'String!' },
        resolve: (r, a) => {
          const name = String(a.qualifiedName);
          return refValue(r, name) ?? refValue(r, `refs/heads/${name}`) ?? refValue(r, `refs/tags/${name}`);
        },
      },
      refs: {
        type: 'RefConnection',
        args: { ...CONN_ARGS, refPrefix: 'String!', query: 'String', orderBy: 'RefOrder', direction: 'OrderDirection' },
        resolve: (r, a) => {
          const prefix = String(a.refPrefix ?? 'refs/');
          let list = [...r.git.refs.keys()].filter((name) => name.startsWith(prefix)).sort();
          if (typeof a.query === 'string' && a.query) list = list.filter((name) => name.slice(prefix.length).includes(a.query));
          return connection(list, a, (name) => ({ __typename: 'Ref', repo: r, name }));
        },
      },
      object: {
        type: 'GitObject',
        args: { expression: 'String', oid: 'GitObjectID' },
        resolve: (r, a) => commitValue(r, r.git.resolve(a.oid ?? a.expression)),
      },
      assignableUsers: { type: 'UserConnection!', args: { ...CONN_ARGS, query: 'String' }, resolve: (r, a) => connection([VIEWER_NODE], a) },
      mentionableUsers: { type: 'UserConnection!', args: { ...CONN_ARGS, query: 'String' }, resolve: (r, a) => connection([VIEWER_NODE], a) },
      collaborators: { type: 'RepositoryCollaboratorConnection', args: CONN_ARGS, resolve: (r, a) => connection([VIEWER_NODE], a) },
      milestones: { type: 'MilestoneConnection', args: { ...CONN_ARGS, states: '[MilestoneState!]' }, resolve: (r, a) => connection([], a) },
      repositoryTopics: { type: 'RepositoryTopicConnection!', args: CONN_ARGS, resolve: (r, a) => connection([], a) },
    },
  },
  Issue: {
    kind: 'OBJECT',
    description: 'An Issue is a place to discuss ideas, enhancements, tasks, and bugs for a project.',
    interfaces: ['Node', 'Closable', 'Comment', 'Labelable', 'Assignable'],
    fields: {
      ...issueLike('Issue'),
      state: { type: 'IssueState!', resolve: (v) => v.item.state.toUpperCase() },
      stateReason: { type: 'IssueStateReason', resolve: (v) => (v.item.stateReason ? v.item.stateReason.toUpperCase() : null) },
      isPinned: { type: 'Boolean', resolve: () => false },
      trackedIssues: { type: 'IssueConnection!', args: CONN_ARGS, resolve: (v, a) => connection([], a) },
      subIssues: { type: 'IssueConnection!', args: CONN_ARGS, resolve: (v, a) => connection([], a) },
      parent: { type: 'Issue', resolve: () => null },
      issueType: { type: 'IssueType', resolve: () => null },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    description: 'A repository pull request.',
    interfaces: ['Node', 'Closable', 'Comment', 'Labelable', 'Assignable'],
    fields: {
      ...issueLike('PullRequest'),
      state: { type: 'PullRequestState!', resolve: (v) => pullState(v.item) },
      merged: { type: 'Boolean!', resolve: (v) => v.item.merged },
      mergedAt: { type: 'DateTime', resolve: (v) => v.item.mergedAt },
      mergedBy: { type: 'Actor', resolve: (v) => (v.item.merged ? VIEWER_NODE : null) },
      isDraft: { type: 'Boolean!', resolve: (v) => v.item.draft },
      headRefName: { type: 'String!', resolve: (v) => v.item.head },
      baseRefName: { type: 'String!', resolve: (v) => v.item.base },
      headRefOid: { type: 'GitObjectID!', resolve: (v) => F.pullTips(v.repo, v.item).head },
      baseRefOid: { type: 'GitObjectID!', resolve: (v) => F.pullTips(v.repo, v.item).base },
      headRef: { type: 'Ref', resolve: (v) => refValue(v.repo, `refs/heads/${v.item.head}`) },
      baseRef: { type: 'Ref', resolve: (v) => refValue(v.repo, `refs/heads/${v.item.base}`) },
      headRepository: { type: 'Repository', resolve: (v) => v.repo },
      baseRepository: { type: 'Repository', resolve: (v) => v.repo },
      headRepositoryOwner: { type: 'RepositoryOwner', resolve: () => VIEWER_NODE },
      isCrossRepository: { type: 'Boolean!', resolve: () => false },
      maintainerCanModify: { type: 'Boolean!', resolve: () => false },
      mergeable: {
        type: 'MergeableState!',
        resolve: (v) => {
          const result = F.pullMergeable(v.repo, v.item);
          return result === true ? 'MERGEABLE' : result === false ? 'CONFLICTING' : 'UNKNOWN';
        },
      },
      mergeStateStatus: {
        type: 'MergeStateStatus!',
        resolve: (v) => {
          const result = F.pullMergeable(v.repo, v.item);
          return result === true ? 'CLEAN' : result === false ? 'DIRTY' : 'UNKNOWN';
        },
      },
      mergeCommit: { type: 'Commit', resolve: (v) => commitValue(v.repo, v.item.mergeCommitSha) },
      potentialMergeCommit: { type: 'Commit', resolve: () => null },
      reviewDecision: { type: 'PullRequestReviewDecision', resolve: () => null },
      additions: { type: 'Int!', resolve: (v) => F.pullFiles(v.repo, v.item).reduce((sum, file) => sum + file.additions, 0) },
      deletions: { type: 'Int!', resolve: (v) => F.pullFiles(v.repo, v.item).reduce((sum, file) => sum + file.deletions, 0) },
      changedFiles: { type: 'Int!', resolve: (v) => F.pullFiles(v.repo, v.item).length },
      files: {
        type: 'PullRequestChangedFileConnection',
        args: CONN_ARGS,
        resolve: (v, a) => connection(F.pullFiles(v.repo, v.item), a, (file) => ({ __typename: 'PullRequestChangedFile', file })),
      },
      commits: {
        type: 'PullRequestCommitConnection!',
        args: CONN_ARGS,
        resolve: (v, a) => {
          const { head, base } = F.pullTips(v.repo, v.item);
          const exclude = base ? v.repo.git.ancestors(base) : new Set();
          const oids = head ? v.repo.git.log(head).filter((oid) => !exclude.has(oid)).reverse() : [];
          return connection(oids, a, (oid) => ({ __typename: 'PullRequestCommit', repo: v.repo, oid }));
        },
      },
      reviews: { type: 'PullRequestReviewConnection', args: { ...CONN_ARGS, states: '[PullRequestReviewState!]' }, resolve: (v, a) => connection([], a) },
      reviewRequests: { type: 'ReviewRequestConnection', args: CONN_ARGS, resolve: (v, a) => connection([], a) },
      autoMergeRequest: { type: 'AutoMergeRequest', resolve: () => null },
      permalink: { type: 'URI!', resolve: (v, a, ctx) => `${ctx.origin}/${F.VIEWER.login}/${v.repo.name}/pull/${v.item.number}` },
    },
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    description: 'A file changed in a pull request.',
    fields: {
      path: { type: 'String!', resolve: (v) => v.file.path },
      additions: { type: 'Int!', resolve: (v) => v.file.additions },
      deletions: { type: 'Int!', resolve: (v) => v.file.deletions },
      changeType: { type: 'PatchStatus!', resolve: (v) => ({ added: 'ADDED', removed: 'DELETED', modified: 'MODIFIED' })[v.file.status] ?? 'CHANGED' },
      viewerViewedState: { type: 'FileViewedState!', resolve: () => 'UNVIEWED' },
    },
  },
  PullRequestCommit: {
    kind: 'OBJECT',
    description: 'Represents a Git commit part of a pull request.',
    interfaces: ['Node'],
    fields: {
      id: { type: 'ID!', resolve: (v) => F.nodeIdOf('PURC', 'PullRequestCommit', v.oid) },
      commit: { type: 'Commit!', resolve: (v) => commitValue(v.repo, v.oid) },
      url: { type: 'URI!', resolve: (v, a, ctx) => `${ctx.origin}/${F.VIEWER.login}/${v.repo.name}/commit/${v.oid}` },
    },
  },
  Ref: {
    kind: 'OBJECT',
    description: 'Represents a Git reference.',
    interfaces: ['Node'],
    fields: {
      id: { type: 'ID!', resolve: (v) => F.nodeIdOf('REF', 'Ref', `${v.repo.id}:${v.name}`) },
      name: { type: 'String!', resolve: (v) => v.name.replace(/^refs\/(heads|tags)\//, '') },
      prefix: { type: 'String!', resolve: (v) => (/^refs\/(heads|tags)\//.exec(v.name)?.[0] ?? 'refs/') },
      target: { type: 'GitObject', resolve: (v) => commitValue(v.repo, v.repo.git.peel(v.repo.git.refs.get(v.name))) },
      repository: { type: 'Repository!', resolve: (v) => v.repo },
      associatedPullRequests: {
        type: 'PullRequestConnection!',
        args: { ...CONN_ARGS, states: '[PullRequestState!]' },
        resolve: (v, a) => {
          const short = v.name.replace(/^refs\/heads\//, '');
          const states = statesFilter(a.states);
          const list = [...v.repo.pulls.values()].filter((pull) => pull.head === short && (!states || states.has(pullState(pull))));
          return connection(list, a, (pull) => ({ __typename: 'PullRequest', repo: v.repo, item: pull }));
        },
      },
    },
  },
  Commit: {
    kind: 'OBJECT',
    description: 'Represents a Git commit.',
    interfaces: ['Node', 'GitObject'],
    fields: {
      id: { type: 'ID!', resolve: (v) => F.nodeIdOf('C', 'Commit', v.oid) },
      oid: { type: 'GitObjectID!', resolve: (v) => v.oid },
      abbreviatedOid: { type: 'String!', resolve: (v) => v.oid.slice(0, 7) },
      message: { type: 'String!', resolve: (v) => v.repo.git.commit(v.oid).message.replace(/\n$/, '') },
      messageHeadline: { type: 'String!', resolve: (v) => v.repo.git.commit(v.oid).message.split('\n')[0] },
      messageBody: { type: 'String!', resolve: (v) => v.repo.git.commit(v.oid).message.split('\n').slice(2).join('\n').replace(/\n$/, '') },
      committedDate: { type: 'DateTime!', resolve: (v) => ts(v.repo.git.commit(v.oid).committer.time) },
      authoredDate: { type: 'DateTime!', resolve: (v) => ts(v.repo.git.commit(v.oid).author.time) },
      author: { type: 'GitActor', resolve: (v) => v.repo.git.commit(v.oid).author },
      committer: { type: 'GitActor', resolve: (v) => v.repo.git.commit(v.oid).committer },
      url: { type: 'URI!', resolve: (v, a, ctx) => `${ctx.origin}/${F.VIEWER.login}/${v.repo.name}/commit/${v.oid}` },
      tree: { type: 'Tree!', resolve: (v) => ({ oid: v.repo.git.commit(v.oid).tree }) },
      parents: {
        type: 'CommitConnection!',
        args: CONN_ARGS,
        resolve: (v, a) => connection(v.repo.git.commit(v.oid).parents, a, (oid) => commitValue(v.repo, oid)),
      },
      history: {
        type: 'CommitHistoryConnection!',
        args: { ...CONN_ARGS, path: 'String' },
        resolve: (v, a) => connection(v.repo.git.log(v.oid, 500), a, (oid) => commitValue(v.repo, oid)),
      },
      repository: { type: 'Repository!', resolve: (v) => v.repo },
    },
  },
  Tree: { kind: 'OBJECT', description: 'Represents a Git tree.', interfaces: ['Node', 'GitObject'], fields: { oid: { type: 'GitObjectID!' }, id: { type: 'ID!', resolve: (v) => F.nodeIdOf('T', 'Tree', v.oid) } } },
  GitActor: {
    kind: 'OBJECT',
    description: 'Represents an actor in a Git commit (ie. an author or committer).',
    fields: {
      name: { type: 'String', resolve: (v) => v.name },
      email: { type: 'String', resolve: (v) => v.email },
      date: { type: 'GitTimestamp', resolve: (v) => ts(v.time) },
      user: { type: 'User', resolve: (v) => (v.email === F.VIEWER_EMAIL ? VIEWER_NODE : null) },
    },
  },
  Label: {
    kind: 'OBJECT',
    description: 'A label for categorizing Issues, Pull Requests, Milestones, or Discussions with a given Repository.',
    interfaces: ['Node'],
    fields: {
      id: { type: 'ID!', resolve: (v) => v.item.nodeId },
      name: { type: 'String!', resolve: (v) => v.item.name },
      color: { type: 'String!', resolve: (v) => v.item.color },
      description: { type: 'String', resolve: (v) => v.item.description },
      isDefault: { type: 'Boolean!', resolve: () => false },
      url: { type: 'URI!', resolve: (v, a, ctx) => `${ctx.origin}/${F.VIEWER.login}/${v.repo.name}/labels/${encodeURIComponent(v.item.name)}` },
      repository: { type: 'Repository!', resolve: (v) => v.repo },
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    description: 'Represents a comment on an Issue.',
    interfaces: ['Node', 'Comment'],
    fields: {
      id: { type: 'ID!', resolve: (v) => v.item.nodeId },
      databaseId: { type: 'Int', resolve: (v) => v.item.id },
      body: { type: 'String!', resolve: (v) => v.item.body },
      bodyText: { type: 'String!', resolve: (v) => v.item.body },
      createdAt: { type: 'DateTime!', resolve: (v) => v.item.createdAt },
      updatedAt: { type: 'DateTime!', resolve: (v) => v.item.updatedAt },
      author: { type: 'Actor', resolve: () => VIEWER_NODE },
      authorAssociation: { type: 'CommentAuthorAssociation!', resolve: () => 'OWNER' },
      url: { type: 'URI!', resolve: (v, a, ctx) => `${ctx.origin}/${F.VIEWER.login}/${v.repo.name}/issues/${v.item.number}#issuecomment-${v.item.id}` },
      viewerDidAuthor: { type: 'Boolean!', resolve: () => true },
      issue: {
        type: 'Issue!',
        resolve: (v) => {
          const issue = v.repo.issues.get(v.item.number);
          return issue ? { __typename: 'Issue', repo: v.repo, item: issue } : null;
        },
      },
      repository: { type: 'Repository!', resolve: (v) => v.repo },
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    description: 'Information about pagination in a connection.',
    fields: {
      hasNextPage: { type: 'Boolean!' },
      hasPreviousPage: { type: 'Boolean!' },
      startCursor: { type: 'String' },
      endCursor: { type: 'String' },
    },
  },
  RateLimit: {
    kind: 'OBJECT',
    description: 'Represents the client\'s rate limit.',
    fields: { limit: { type: 'Int!' }, cost: { type: 'Int!' }, remaining: { type: 'Int!' }, used: { type: 'Int!' }, nodeCount: { type: 'Int!' }, resetAt: { type: 'DateTime!' } },
  },
  GitHubMetadata: {
    kind: 'OBJECT',
    description: 'Represents information about the GitHub instance.',
    fields: { installedVersion: { type: 'String!' }, isPasswordAuthenticationVerifiable: { type: 'Boolean!' } },
  },
  SearchResultItemConnection: {
    kind: 'OBJECT',
    description: 'A list of results that matched against a search query.',
    fields: {
      issueCount: { type: 'Int!' },
      repositoryCount: { type: 'Int!' },
      userCount: { type: 'Int!' },
      discussionCount: { type: 'Int!' },
      codeCount: { type: 'Int!' },
      wikiCount: { type: 'Int!' },
      nodes: { type: '[SearchResultItem]' },
      edges: { type: '[SearchResultItemEdge]' },
      pageInfo: { type: 'PageInfo!' },
    },
  },
  SearchResultItemEdge: { kind: 'OBJECT', description: 'An edge in a connection.', fields: { cursor: { type: 'String!' }, node: { type: 'SearchResultItem' } } },
  ...connectionTypes('Issue', 'Issue'),
  ...connectionTypes('PullRequest', 'PullRequest'),
  ...connectionTypes('PullRequestChangedFile', 'PullRequestChangedFile'),
  ...connectionTypes('PullRequestCommit', 'PullRequestCommit'),
  ...connectionTypes('Repository', 'Repository'),
  ...connectionTypes('Label', 'Label'),
  ...connectionTypes('IssueComment', 'IssueComment'),
  ...connectionTypes('User', 'User'),
  ...connectionTypes('Ref', 'Ref'),
  ...connectionTypes('Commit', 'Commit'),
  ...connectionTypes('CommitHistory', 'Commit'),
  ...connectionTypes('RepositoryCollaborator', 'User'),
  ...connectionTypes('Milestone', 'Milestone'),
  ...connectionTypes('RepositoryTopic', 'RepositoryTopic'),
  ...connectionTypes('ProjectCard', 'ProjectCard'),
  ...connectionTypes('ProjectV2Item', 'ProjectV2Item'),
  ...connectionTypes('PullRequestReview', 'PullRequestReview'),
  ...connectionTypes('ReviewRequest', 'ReviewRequest'),
  Milestone: { kind: 'OBJECT', description: 'Represents a Milestone object on a given repository.', fields: { id: { type: 'ID!' }, title: { type: 'String!' }, number: { type: 'Int!' } } },
  RepositoryTopic: { kind: 'OBJECT', description: 'A repository-topic connects a repository to a topic.', fields: { id: { type: 'ID!' } } },
  ProjectCard: { kind: 'OBJECT', description: 'A card in a project.', fields: { id: { type: 'ID!' } } },
  ProjectV2Item: { kind: 'OBJECT', description: 'An item within a Project.', fields: { id: { type: 'ID!' } } },
  PullRequestReview: { kind: 'OBJECT', description: 'A review object for a given pull request.', fields: { id: { type: 'ID!' }, state: { type: 'PullRequestReviewState!' } } },
  ReviewRequest: { kind: 'OBJECT', description: 'A request for a user to review a pull request.', fields: { id: { type: 'ID!' } } },
  ReactionGroup: { kind: 'OBJECT', description: 'A group of emoji reactions to a particular piece of content.', fields: { content: { type: 'ReactionContent!' } } },
  Language: { kind: 'OBJECT', description: 'Represents a given language found in repositories.', fields: { name: { type: 'String!' }, color: { type: 'String' } } },
  IssueType: { kind: 'OBJECT', description: 'Represents the type of Issue.', fields: { id: { type: 'ID!' }, name: { type: 'String!' } } },
  AutoMergeRequest: { kind: 'OBJECT', description: 'Represents an auto-merge request for a pull request.', fields: { enabledAt: { type: 'DateTime' } } },
  CreateIssuePayload: { kind: 'OBJECT', description: 'Autogenerated return type of CreateIssue.', fields: { clientMutationId: { type: 'String' }, issue: { type: 'Issue' } } },
  UpdateIssuePayload: { kind: 'OBJECT', description: 'Autogenerated return type of UpdateIssue.', fields: { clientMutationId: { type: 'String' }, issue: { type: 'Issue' } } },
  CloseIssuePayload: { kind: 'OBJECT', description: 'Autogenerated return type of CloseIssue.', fields: { clientMutationId: { type: 'String' }, issue: { type: 'Issue' } } },
  ReopenIssuePayload: { kind: 'OBJECT', description: 'Autogenerated return type of ReopenIssue.', fields: { clientMutationId: { type: 'String' }, issue: { type: 'Issue' } } },
  AddCommentPayload: {
    kind: 'OBJECT',
    description: 'Autogenerated return type of AddComment.',
    fields: { clientMutationId: { type: 'String' }, commentEdge: { type: 'IssueCommentEdge' }, subject: { type: 'Node' }, timelineEdge: { type: 'IssueCommentEdge' } },
  },
  CreatePullRequestPayload: { kind: 'OBJECT', description: 'Autogenerated return type of CreatePullRequest.', fields: { clientMutationId: { type: 'String' }, pullRequest: { type: 'PullRequest' } } },
  MergePullRequestPayload: { kind: 'OBJECT', description: 'Autogenerated return type of MergePullRequest.', fields: { clientMutationId: { type: 'String' }, pullRequest: { type: 'PullRequest' } } },
  ClosePullRequestPayload: { kind: 'OBJECT', description: 'Autogenerated return type of ClosePullRequest.', fields: { clientMutationId: { type: 'String' }, pullRequest: { type: 'PullRequest' } } },
  ReopenPullRequestPayload: { kind: 'OBJECT', description: 'Autogenerated return type of ReopenPullRequest.', fields: { clientMutationId: { type: 'String' }, pullRequest: { type: 'PullRequest' } } },
  UpdatePullRequestPayload: { kind: 'OBJECT', description: 'Autogenerated return type of UpdatePullRequest.', fields: { clientMutationId: { type: 'String' }, pullRequest: { type: 'PullRequest' } } },
  CreateRepositoryPayload: { kind: 'OBJECT', description: 'Autogenerated return type of CreateRepository.', fields: { clientMutationId: { type: 'String' }, repository: { type: 'Repository' } } },
  AddLabelsToLabelablePayload: { kind: 'OBJECT', description: 'Autogenerated return type of AddLabelsToLabelable.', fields: { clientMutationId: { type: 'String' }, labelable: { type: 'Labelable' } } },
  Node: { kind: 'INTERFACE', description: 'An object with an ID.', fields: { id: { type: 'ID!' } } },
  Actor: { kind: 'INTERFACE', description: 'Represents an object which can take actions on GitHub.', fields: { ...actorFields } },
  RepositoryOwner: {
    kind: 'INTERFACE',
    description: 'Represents an owner of a Repository.',
    fields: { id: { type: 'ID!' }, ...actorFields, repository: { type: 'Repository', args: { name: 'String!' } } },
  },
  RepositoryInfo: { kind: 'INTERFACE', description: 'A subset of repository info.', fields: { name: { type: 'String!' }, nameWithOwner: { type: 'String!' }, description: { type: 'String' } } },
  GitObject: { kind: 'INTERFACE', description: 'Represents a Git object.', fields: { oid: { type: 'GitObjectID!' }, id: { type: 'ID!' } } },
  Closable: { kind: 'INTERFACE', description: 'An object that can be closed.', fields: { closed: { type: 'Boolean!' }, closedAt: { type: 'DateTime' } } },
  Comment: { kind: 'INTERFACE', description: 'Represents a comment.', fields: { body: { type: 'String!' }, createdAt: { type: 'DateTime!' }, id: { type: 'ID!' } } },
  Labelable: { kind: 'INTERFACE', description: 'An object that can have labels assigned to it.', fields: { labels: { type: 'LabelConnection', args: CONN_ARGS } } },
  Assignable: { kind: 'INTERFACE', description: 'An object that can have users assigned to it.', fields: { assignees: { type: 'UserConnection!', args: CONN_ARGS } } },
  SearchResultItem: { kind: 'UNION', description: 'The results of a search.', possibleTypes: ['Issue', 'PullRequest', 'Repository', 'User'] },
  IssueOrPullRequest: { kind: 'UNION', description: 'Used for return value of Repository.issueOrPullRequest.', possibleTypes: ['Issue', 'PullRequest'] },
  IssueState: enumType('The possible states of an issue.', ['OPEN', 'CLOSED']),
  IssueStateReason: enumType('The possible state reasons of an issue.', ['COMPLETED', 'NOT_PLANNED', 'REOPENED', 'DUPLICATE']),
  PullRequestState: enumType('The possible states of a pull request.', ['OPEN', 'CLOSED', 'MERGED']),
  MergeableState: enumType('Whether or not a PullRequest can be merged.', ['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  MergeStateStatus: enumType('Detailed status information about a pull request merge.', ['CLEAN', 'DIRTY', 'UNKNOWN', 'BLOCKED', 'BEHIND', 'DRAFT', 'HAS_HOOKS', 'UNSTABLE']),
  PullRequestMergeMethod: enumType('Represents available types of methods to use when merging a pull request.', ['MERGE', 'SQUASH', 'REBASE']),
  RepositoryPermission: enumType('The access level to a repository.', ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ']),
  RepositoryVisibility: enumType('The repository\'s visibility level.', ['PRIVATE', 'PUBLIC', 'INTERNAL']),
  RepositoryPrivacy: enumType('The privacy of a repository.', ['PUBLIC', 'PRIVATE']),
  RepositoryAffiliation: enumType('The affiliation of a user to a repository.', ['OWNER', 'COLLABORATOR', 'ORGANIZATION_MEMBER']),
  SearchType: enumType('Represents the individual results of a search.', ['ISSUE', 'ISSUE_ADVANCED', 'REPOSITORY', 'USER', 'DISCUSSION']),
  IssueOrderField: enumType('Properties by which issue connections can be ordered.', ['CREATED_AT', 'UPDATED_AT', 'COMMENTS']),
  OrderDirection: enumType('Possible directions in which to order a list of items when provided an `orderBy` argument.', ['ASC', 'DESC']),
  PatchStatus: enumType('The possible types of patch statuses.', ['ADDED', 'DELETED', 'RENAMED', 'COPIED', 'MODIFIED', 'CHANGED']),
  CommentAuthorAssociation: enumType('A comment author association with repository.', ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'NONE']),
  SubscriptionState: enumType('The possible states of a subscription.', ['UNSUBSCRIBED', 'SUBSCRIBED', 'IGNORED']),
  PullRequestReviewDecision: enumType('The review status of a pull request.', ['CHANGES_REQUESTED', 'APPROVED', 'REVIEW_REQUIRED']),
  PullRequestReviewState: enumType('The possible states of a pull request review.', ['PENDING', 'COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']),
  MilestoneState: enumType('The possible states of a milestone.', ['OPEN', 'CLOSED']),
  FileViewedState: enumType('The possible viewed states of a file .', ['DISMISSED', 'VIEWED', 'UNVIEWED']),
  ReactionContent: enumType('Emojis that can be attached to Issues, Pull Requests and Comments.', ['THUMBS_UP', 'THUMBS_DOWN', 'LAUGH', 'HOORAY', 'CONFUSED', 'HEART', 'ROCKET', 'EYES']),
  IssueOrder: inputType('Ways in which lists of issues can be ordered upon return.', { field: 'IssueOrderField!', direction: 'OrderDirection!' }),
  IssueFilters: inputType('Ways in which to filter lists of issues.', { states: '[IssueState!]', labels: '[String!]', assignee: 'String', createdBy: 'String' }),
  LabelOrder: inputType('Ways in which lists of labels can be ordered upon return.', { field: 'String!', direction: 'OrderDirection!' }),
  IssueCommentOrder: inputType('Ways in which lists of issue comments can be ordered upon return.', { field: 'String!', direction: 'OrderDirection!' }),
  RepositoryOrder: inputType('Ordering options for repository connections.', { field: 'String!', direction: 'OrderDirection!' }),
  RefOrder: inputType('Ways in which lists of git refs can be ordered upon return.', { field: 'String!', direction: 'OrderDirection!' }),
  CreateIssueInput: inputType('Autogenerated input type of CreateIssue.', { repositoryId: 'ID!', title: 'String!', body: 'String', labelIds: '[ID!]', assigneeIds: '[ID!]', milestoneId: 'ID', clientMutationId: 'String' }),
  UpdateIssueInput: inputType('Autogenerated input type of UpdateIssue.', { id: 'ID!', title: 'String', body: 'String', state: 'IssueState', labelIds: '[ID!]', clientMutationId: 'String' }),
  CloseIssueInput: inputType('Autogenerated input type of CloseIssue.', { issueId: 'ID!', stateReason: 'IssueStateReason', clientMutationId: 'String' }),
  ReopenIssueInput: inputType('Autogenerated input type of ReopenIssue.', { issueId: 'ID!', clientMutationId: 'String' }),
  AddCommentInput: inputType('Autogenerated input type of AddComment.', { subjectId: 'ID!', body: 'String!', clientMutationId: 'String' }),
  CreatePullRequestInput: inputType('Autogenerated input type of CreatePullRequest.', { repositoryId: 'ID!', baseRefName: 'String!', headRefName: 'String!', title: 'String!', body: 'String', draft: 'Boolean', maintainerCanModify: 'Boolean', clientMutationId: 'String' }),
  MergePullRequestInput: inputType('Autogenerated input type of MergePullRequest.', { pullRequestId: 'ID!', mergeMethod: 'PullRequestMergeMethod', commitHeadline: 'String', commitBody: 'String', expectedHeadOid: 'GitObjectID', clientMutationId: 'String' }),
  ClosePullRequestInput: inputType('Autogenerated input type of ClosePullRequest.', { pullRequestId: 'ID!', clientMutationId: 'String' }),
  ReopenPullRequestInput: inputType('Autogenerated input type of ReopenPullRequest.', { pullRequestId: 'ID!', clientMutationId: 'String' }),
  UpdatePullRequestInput: inputType('Autogenerated input type of UpdatePullRequest.', { pullRequestId: 'ID!', title: 'String', body: 'String', baseRefName: 'String', state: 'PullRequestUpdateState', clientMutationId: 'String' }),
  PullRequestUpdateState: enumType('The possible target states when updating a pull request.', ['OPEN', 'CLOSED']),
  CreateRepositoryInput: inputType('Autogenerated input type of CreateRepository.', { name: 'String!', description: 'String', visibility: 'RepositoryVisibility!', homepageUrl: 'URI', hasIssuesEnabled: 'Boolean', clientMutationId: 'String' }),
  AddLabelsToLabelableInput: inputType('Autogenerated input type of AddLabelsToLabelable.', { labelableId: 'ID!', labelIds: '[ID!]!', clientMutationId: 'String' }),
  GitSSHRemote: { kind: 'SCALAR', description: 'Git SSH string' },
};
for (const scalar of SCALARS) TYPES[scalar] = { kind: 'SCALAR', description: `The \`${scalar}\` scalar type.` };

const IMPLEMENTS = new Map();
for (const [name, type] of Object.entries(TYPES)) {
  for (const iface of type.interfaces ?? []) {
    if (!IMPLEMENTS.has(iface)) IMPLEMENTS.set(iface, []);
    IMPLEMENTS.get(iface).push(name);
  }
}

/** Whether a value of runtime type `typeName` satisfies a fragment's `condition`. */
function applies(condition, typeName) {
  if (!condition || condition === typeName) return true;
  const type = TYPES[condition];
  if (!type) return false;
  if (type.kind === 'INTERFACE') return (IMPLEMENTS.get(condition) ?? []).includes(typeName);
  if (type.kind === 'UNION') return type.possibleTypes.includes(typeName);
  return false;
}

/** The fields an abstract type exposes for validation: its own, plus every possible type's. */
function fieldsOf(typeName) {
  const type = TYPES[typeName];
  if (!type) return null;
  return type.fields ?? {};
}

// ------------------------------------------------------------------ search

function search(args) {
  const query = String(args.query ?? '');
  const type = String(args.type ?? 'ISSUE');
  const tokens = query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  const qualifiers = {};
  const words = [];
  for (const token of tokens) {
    const match = /^([a-z-]+):(.*)$/i.exec(token);
    if (match) (qualifiers[match[1].toLowerCase()] ??= []).push(match[2].replace(/^"|"$/g, ''));
    else words.push(token.replace(/^"|"$/g, '').toLowerCase());
  }
  const matchesText = (text) => words.every((word) => text.toLowerCase().includes(word));
  let nodes = [];
  if (type === 'REPOSITORY') {
    nodes = F.listRepos().filter((repo) => matchesText(`${repo.name} ${repo.description ?? ''}`));
  } else if (type === 'USER') {
    nodes = matchesText(F.VIEWER.login) ? [VIEWER_NODE] : [];
  } else if (type === 'ISSUE' || type === 'ISSUE_ADVANCED') {
    let repos = F.listRepos();
    if (qualifiers.repo) repos = qualifiers.repo.map((full) => full.split('/')).map(([owner, name]) => F.getRepo(owner, name)).filter(Boolean);
    const is = new Set([...(qualifiers.is ?? []), ...(qualifiers.type ?? [])].map((value) => value.toLowerCase()));
    const state = (qualifiers.state ?? [])[0]?.toLowerCase();
    for (const repo of repos) {
      const items = [];
      if (!is.has('pr') && !is.has('pull-request')) for (const issue of repo.issues.values()) items.push({ __typename: 'Issue', repo, item: issue });
      if (!is.has('issue')) for (const pull of repo.pulls.values()) items.push({ __typename: 'PullRequest', repo, item: pull });
      for (const entry of items) {
        const open = entry.item.state === 'open';
        if ((is.has('open') || state === 'open') && !open) continue;
        if ((is.has('closed') || state === 'closed') && open) continue;
        if (is.has('merged') && !entry.item.merged) continue;
        if (qualifiers.label && !qualifiers.label.every((name) => entry.item.labels.some((label) => label.toLowerCase() === name.toLowerCase()))) continue;
        if (!matchesText(`${entry.item.title} ${entry.item.body ?? ''}`)) continue;
        nodes.push(entry);
      }
    }
    nodes.sort((a, b) => b.item.seq - a.item.seq);
  }
  const result = connection(nodes, args);
  return {
    ...result,
    issueCount: type.startsWith('ISSUE') ? nodes.length : 0,
    repositoryCount: type === 'REPOSITORY' ? nodes.length : 0,
    userCount: type === 'USER' ? nodes.length : 0,
    discussionCount: 0,
    codeCount: 0,
    wikiCount: 0,
  };
}

// ------------------------------------------------------------------ introspection

function typeRef(type) {
  if (type.endsWith('!')) return { kind: 'NON_NULL', name: null, ofType: typeRef(type.slice(0, -1)) };
  if (type.startsWith('[')) return { kind: 'LIST', name: null, ofType: typeRef(type.slice(1, -1)) };
  return namedType(type);
}

function namedType(name) {
  const type = TYPES[name];
  if (!type) return null;
  return { kind: type.kind, name, description: type.description ?? null, ofType: null, __named: true };
}

function inputValues(map) {
  return Object.entries(map ?? {}).map(([name, type]) => ({ name, description: null, type: typeRef(type), defaultValue: null, isDeprecated: false, deprecationReason: null }));
}

const INTROSPECTION = {
  __Type: {
    kind: 'OBJECT',
    description: 'The fundamental unit of any GraphQL Schema is the type.',
    fields: {
      kind: { type: '__TypeKind!' },
      name: { type: 'String' },
      description: { type: 'String', resolve: (t) => t.description ?? null },
      specifiedByURL: { type: 'String', resolve: () => null },
      fields: {
        type: '[__Field!]',
        args: { includeDeprecated: 'Boolean' },
        resolve: (t) => {
          const type = t.__named ? TYPES[t.name] : null;
          if (!type || (type.kind !== 'OBJECT' && type.kind !== 'INTERFACE')) return null;
          return Object.entries(type.fields ?? {}).map(([name, def]) => ({
            name,
            description: def.description ?? null,
            args: inputValues(def.args),
            type: typeRef(def.type),
            isDeprecated: false,
            deprecationReason: null,
          }));
        },
      },
      interfaces: {
        type: '[__Type!]',
        resolve: (t) => {
          const type = t.__named ? TYPES[t.name] : null;
          if (!type || type.kind !== 'OBJECT') return type && type.kind === 'INTERFACE' ? [] : null;
          return (type.interfaces ?? []).map(namedType);
        },
      },
      possibleTypes: {
        type: '[__Type!]',
        resolve: (t) => {
          const type = t.__named ? TYPES[t.name] : null;
          if (!type) return null;
          if (type.kind === 'UNION') return type.possibleTypes.map(namedType);
          if (type.kind === 'INTERFACE') return (IMPLEMENTS.get(t.name) ?? []).map(namedType);
          return null;
        },
      },
      enumValues: {
        type: '[__EnumValue!]',
        args: { includeDeprecated: 'Boolean' },
        resolve: (t) => {
          const type = t.__named ? TYPES[t.name] : null;
          if (!type || type.kind !== 'ENUM') return null;
          return type.values.map((name) => ({ name, description: null, isDeprecated: false, deprecationReason: null }));
        },
      },
      inputFields: {
        type: '[__InputValue!]',
        args: { includeDeprecated: 'Boolean' },
        resolve: (t) => {
          const type = t.__named ? TYPES[t.name] : null;
          if (!type || type.kind !== 'INPUT_OBJECT') return null;
          return inputValues(type.inputFields);
        },
      },
      ofType: { type: '__Type', resolve: (t) => t.ofType ?? null },
      isOneOf: { type: 'Boolean', resolve: () => false },
    },
  },
  __Field: {
    kind: 'OBJECT',
    description: 'Object and Interface types are described by a list of Fields, each of which has a name, potentially a list of arguments, and a return type.',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String' },
      args: { type: '[__InputValue!]!', args: { includeDeprecated: 'Boolean' } },
      type: { type: '__Type!' },
      isDeprecated: { type: 'Boolean!' },
      deprecationReason: { type: 'String' },
    },
  },
  __InputValue: {
    kind: 'OBJECT',
    description: 'Arguments provided to Fields or Directives and the input fields of an InputObject are represented as Input Values which describe their type and optionally a default value.',
    fields: { name: { type: 'String!' }, description: { type: 'String' }, type: { type: '__Type!' }, defaultValue: { type: 'String' }, isDeprecated: { type: 'Boolean!' }, deprecationReason: { type: 'String' } },
  },
  __EnumValue: {
    kind: 'OBJECT',
    description: 'One possible value for a given Enum.',
    fields: { name: { type: 'String!' }, description: { type: 'String' }, isDeprecated: { type: 'Boolean!' }, deprecationReason: { type: 'String' } },
  },
  __Directive: {
    kind: 'OBJECT',
    description: 'A Directive provides a way to describe alternate runtime execution and type validation behavior in a GraphQL document.',
    fields: { name: { type: 'String!' }, description: { type: 'String' }, locations: { type: '[__DirectiveLocation!]!' }, args: { type: '[__InputValue!]!' }, isRepeatable: { type: 'Boolean!' } },
  },
  __Schema: {
    kind: 'OBJECT',
    description: 'A GraphQL Schema defines the capabilities of a GraphQL server.',
    fields: {
      description: { type: 'String', resolve: () => null },
      types: { type: '[__Type!]!', resolve: () => Object.keys(TYPES).concat(Object.keys(INTROSPECTION)).map(namedType) },
      queryType: { type: '__Type!', resolve: () => namedType('Query') },
      mutationType: { type: '__Type', resolve: () => namedType('Mutation') },
      subscriptionType: { type: '__Type', resolve: () => null },
      directives: {
        type: '[__Directive!]!',
        resolve: () => ['include', 'skip'].map((name) => ({ name, description: null, locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: inputValues({ if: 'Boolean!' }), isRepeatable: false })),
      },
    },
  },
  __TypeKind: enumType('An enum describing what kind of type a given `__Type` is.', ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL']),
  __DirectiveLocation: enumType('A Directive can be adjacent to many parts of the GraphQL language.', ['QUERY', 'MUTATION', 'FIELD', 'FRAGMENT_DEFINITION', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT']),
};
Object.assign(TYPES, INTROSPECTION);
TYPES.Query.fields.__type = { type: '__Type', args: { name: 'String!' }, resolve: (_, a) => namedType(String(a.name)) };
TYPES.Query.fields.__schema = { type: '__Schema!', resolve: () => ({}) };

// ------------------------------------------------------------------ validation and execution

function valueOf(node, variables) {
  switch (node.kind) {
    case 'Variable': return variables[node.name];
    case 'Int': case 'Float': case 'String': case 'Boolean': case 'Null': case 'Enum': return node.value;
    case 'List': return node.values.map((value) => valueOf(value, variables));
    case 'Object': {
      const out = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
    default: return undefined;
  }
}

function argsOf(field, variables) {
  const out = {};
  for (const arg of field.arguments) {
    const value = valueOf(arg.value, variables);
    if (value !== undefined) out[arg.name] = value;
  }
  return out;
}

function skipped(directives, variables) {
  for (const directive of directives ?? []) {
    const args = {};
    for (const arg of directive.arguments) args[arg.name] = valueOf(arg.value, variables);
    if (directive.name === 'skip' && args.if === true) return true;
    if (directive.name === 'include' && args.if === false) return true;
  }
  return false;
}

/** Report every field the schema does not hold (GitHub's undefinedField errors). */
function validate(selectionSet, typeName, doc, errors, path, seenFragments) {
  const fields = fieldsOf(typeName);
  if (fields === null) return;
  for (const selection of selectionSet) {
    if (selection.kind === 'Field') {
      if (selection.name === '__typename') continue;
      const def = Object.prototype.hasOwnProperty.call(fields, selection.name) ? fields[selection.name] : undefined;
      if (!def) {
        if (TYPES[typeName]?.kind === 'UNION') {
          errors.push({ message: `Selections can't be made directly on unions (see selections on ${typeName})`, locations: [selection.loc], path: [...path, selection.name], extensions: { code: 'selectionMismatch', nodeName: typeName } });
          continue;
        }
        errors.push({
          message: `Field '${selection.name}' doesn't exist on type '${typeName}'`,
          locations: [selection.loc],
          path: [...path, selection.alias ?? selection.name],
          extensions: { code: 'undefinedField', typeName, fieldName: selection.name },
        });
        continue;
      }
      const inner = nameOf(def.type);
      const innerKind = TYPES[inner]?.kind;
      const composite = innerKind === 'OBJECT' || innerKind === 'INTERFACE' || innerKind === 'UNION';
      if (composite && !selection.selectionSet) {
        errors.push({ message: `Field must have selections (field '${selection.name}' returns ${inner} but has no selections. Did you mean '${selection.name} { ... }'?)`, locations: [selection.loc], path: [...path, selection.name], extensions: { code: 'selectionMismatch' } });
      } else if (!composite && selection.selectionSet) {
        errors.push({ message: `Selections can't be made on scalars (field '${selection.name}' returns ${inner} but has selections [${selection.selectionSet.map((child) => child.name ?? '...').join(', ')}])`, locations: [selection.loc], path: [...path, selection.name], extensions: { code: 'selectionMismatch' } });
      } else if (composite) {
        validate(selection.selectionSet, inner, doc, errors, [...path, selection.alias ?? selection.name], seenFragments);
      }
      if (def.args) {
        for (const arg of selection.arguments) {
          if (!(arg.name in def.args)) {
            errors.push({ message: `Field '${selection.name}' doesn't accept argument '${arg.name}'`, locations: [selection.loc], path: [...path, selection.name, arg.name], extensions: { code: 'argumentNotAccepted', name: selection.name, typeName: 'Field', argumentName: arg.name } });
          }
        }
      }
    } else if (selection.kind === 'InlineFragment') {
      const target = selection.typeCondition ?? typeName;
      if (!TYPES[target]) {
        errors.push({ message: `No such type ${target}, so it can't be a fragment condition`, locations: [selection.loc], path, extensions: { code: 'undefinedType', typeName: target } });
        continue;
      }
      validate(selection.selectionSet, target, doc, errors, path, seenFragments);
    } else if (selection.kind === 'FragmentSpread') {
      const fragment = doc.fragments.get(selection.name);
      if (!fragment) {
        errors.push({ message: `Fragment ${selection.name} was used, but not defined`, locations: [selection.loc], path, extensions: { code: 'useAndDefineFragment', fragmentName: selection.name } });
        continue;
      }
      if (seenFragments.has(selection.name)) continue;
      seenFragments.add(selection.name);
      if (!TYPES[fragment.typeCondition]) {
        errors.push({ message: `No such type ${fragment.typeCondition}, so it can't be a fragment condition`, locations: [selection.loc], path, extensions: { code: 'undefinedType', typeName: fragment.typeCondition } });
        continue;
      }
      validate(fragment.selectionSet, fragment.typeCondition, doc, errors, path, seenFragments);
      seenFragments.delete(selection.name);
    }
  }
}

function collectFields(selectionSet, typeName, exec, out = new Map()) {
  for (const selection of selectionSet) {
    if (skipped(selection.directives, exec.variables)) continue;
    if (selection.kind === 'Field') {
      const key = selection.alias ?? selection.name;
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(selection);
    } else if (selection.kind === 'InlineFragment') {
      if (applies(selection.typeCondition, typeName)) collectFields(selection.selectionSet, typeName, exec, out);
    } else if (selection.kind === 'FragmentSpread') {
      const fragment = exec.doc.fragments.get(selection.name);
      if (fragment && applies(fragment.typeCondition, typeName)) collectFields(fragment.selectionSet, typeName, exec, out);
    }
  }
  return out;
}

function executeSelections(typeName, value, selectionSet, exec, path) {
  const result = {};
  const fields = collectFields(selectionSet, typeName, exec);
  const defs = TYPES[typeName].fields ?? {};
  for (const [key, nodes] of fields) {
    const node = nodes[0];
    if (node.name === '__typename') {
      result[key] = typeName;
      continue;
    }
    const def = Object.prototype.hasOwnProperty.call(defs, node.name) ? defs[node.name] : undefined;
    if (!def) {
      result[key] = null;
      continue;
    }
    const fieldPath = [...path, key];
    let resolved;
    try {
      const args = argsOf(node, exec.variables);
      resolved = def.resolve ? def.resolve(value, args, exec.ctx) : value?.[node.name];
    } catch (err) {
      exec.errors.push(errorEntry(err, node, fieldPath));
      result[key] = null;
      continue;
    }
    const merged = nodes.length === 1 ? node.selectionSet : nodes.flatMap((item) => item.selectionSet ?? []);
    result[key] = complete(def.type, resolved, merged, exec, fieldPath, node);
  }
  return result;
}

function complete(type, value, selectionSet, exec, path, node) {
  if (value === null || value === undefined) return null;
  if (type.endsWith('!')) return complete(type.slice(0, -1), value, selectionSet, exec, path, node);
  if (type.startsWith('[')) {
    if (!Array.isArray(value)) return null;
    const inner = type.slice(1, -1);
    return value.map((item, index) => complete(inner, item, selectionSet, exec, [...path, index], node));
  }
  const def = TYPES[type];
  if (!def || def.kind === 'SCALAR' || def.kind === 'ENUM') return value;
  let runtime = type;
  if (def.kind === 'INTERFACE' || def.kind === 'UNION') {
    runtime = typeOfValue(value) ?? (type === '__Type' ? '__Type' : null);
    if (!runtime || !TYPES[runtime]) return null;
  }
  if (!selectionSet) return null;
  return executeSelections(runtime, value, selectionSet, exec, path);
}

function errorEntry(err, node, path) {
  const entry = { message: err instanceof Error ? err.message : String(err), locations: node ? [node.loc] : undefined, path };
  if (err instanceof F.ForgeError) {
    entry.type = err.status === 404 ? 'NOT_FOUND' : err.status === 405 ? 'UNPROCESSABLE' : err.status === 409 ? 'UNPROCESSABLE' : 'UNPROCESSABLE';
    if (err.errors && err.errors[0] && err.errors[0].message) entry.message = `${err.message}: ${err.errors[0].message}`;
  } else if (err instanceof GraphQLError && err.extra) {
    Object.assign(entry, err.extra);
  }
  return entry;
}

function coerceVariables(definitions, given) {
  const variables = {};
  const errors = [];
  const supplied = given && typeof given === 'object' && !Array.isArray(given) ? given : {};
  for (const definition of definitions) {
    if (Object.prototype.hasOwnProperty.call(supplied, definition.name)) variables[definition.name] = supplied[definition.name];
    else if (definition.defaultValue !== undefined) variables[definition.name] = valueOf(definition.defaultValue, {});
    else if (definition.type.endsWith('!')) errors.push({ message: `Variable $${definition.name} of type ${definition.type} was provided invalid value`, extensions: { value: null, problems: [{ path: [], explanation: 'Expected value to not be null' }] } });
    if (definition.type === 'Int!' || definition.type === 'Int') {
      const value = variables[definition.name];
      if (typeof value === 'string' && /^-?\d+$/.test(value)) variables[definition.name] = Number(value);
    }
  }
  return { variables, errors };
}

/** Run one {query, variables, operationName} request; answers the {data, errors} envelope. */
export function runOperation(request, ctx) {
  if (!request || typeof request !== 'object' || typeof request.query !== 'string' || request.query.trim() === '') {
    return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
  }
  let doc;
  try {
    doc = parse(request.query);
  } catch (err) {
    return { errors: [{ message: err.message, locations: [] }] };
  }
  let operation = doc.operations[0];
  if (typeof request.operationName === 'string' && request.operationName !== '') {
    operation = doc.operations.find((op) => op.name === request.operationName);
    if (!operation) return { errors: [{ message: `No operation named "${request.operationName}"` }] };
  } else if (doc.operations.length > 1) {
    return { errors: [{ message: 'An operation name is required' }] };
  }
  if (operation.operation === 'subscription') return { errors: [{ message: 'Subscriptions are not supported' }] };
  const root = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const errors = [];
  validate(operation.selectionSet, root, doc, errors, [operation.operation === 'mutation' ? 'mutation' : 'query'], new Set());
  if (errors.length) return { errors };
  const coerced = coerceVariables(operation.variables, request.variables);
  if (coerced.errors.length) return { errors: coerced.errors };
  const exec = { doc, variables: coerced.variables, ctx, errors: [] };
  const data = executeSelections(root, {}, operation.selectionSet, exec, []);
  return exec.errors.length ? { data, errors: exec.errors } : { data };
}

/** POST /api/graphql: one request object, or a JSON array of them (operation batching). */
export function handleGraphQL(body, origin) {
  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: { message: 'Problems parsing JSON', documentation_url: 'https://docs.github.com/graphql' } };
  }
  const ctx = { origin };
  if (Array.isArray(payload)) return { status: 200, body: payload.map((request) => runOperation(request, ctx)) };
  return { status: 200, body: runOperation(payload, ctx) };
}
