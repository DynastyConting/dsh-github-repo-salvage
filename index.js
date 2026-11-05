/**
 * github-repo-salvage
 *
 * Recovers the source of a GitHub repository whose code was erased or whose
 * history was force-pushed away. It is read-only: it inspects the repository,
 * its activity log, and the fork network, then reports which forks still hold
 * commits that the current branch no longer reaches.
 *
 * Why forks: a force-push replaces a ref, it does not rewrite an existing
 * fork. A fork made before the push keeps its own objects, so its default
 * branch still points at the pre-erasure tip. Matching that tip's commit SHA
 * against a known-good SHA is what proves the recovered tree is the original
 * one and not something a later fork owner edited.
 */

export const name = 'github-repo-salvage'
export const inject = ['tools']

const API = 'https://api.github.com'
const ZERO_SHA = /^0+$/

function parseRepo(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('repo is required: pass owner/name, a github.com URL, or a git URL')
  }
  let s = input.trim().replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
  const url = s.match(/github\.com[/:]([^/]+)\/([^/]+)$/i)
  if (url) return { owner: url[1], repo: url[2] }
  const parts = s.split('/')
  if (parts.length === 2 && parts[0] && parts[1]) return { owner: parts[0], repo: parts[1] }
  throw new Error(`cannot parse a repository from "${input}"`)
}

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function readToken(config) {
  if (config && typeof config.token === 'string' && config.token.trim() !== '') return config.token.trim()
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
}

async function gh(pathname, token, signal) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dsh-github-repo-salvage',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(API + pathname, { headers, signal })
  const text = await res.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }
  return {
    ok: res.ok,
    status: res.status,
    data,
    remaining: res.headers.get('x-ratelimit-remaining'),
    message: data && typeof data.message === 'string' ? data.message : '',
  }
}

function forkScore(fork) {
  const size = typeof fork.size === 'number' ? fork.size : 0
  const created = Date.parse(fork.created_at || '') || 0
  return { size, created }
}

/**
 * A fork is worth reporting when it still carries a body of code (size well
 * above an empty repository) and its default branch does not move with the
 * upstream rewrite.
 *
 * @param {object} fork - a fork object from the forks API
 * @param {string} upstreamHead - the current default-branch head of the source
 * @param {string} branch - the source's default branch name
 * @param {string} token - GitHub token, empty for anonymous
 * @param {AbortSignal} signal - cancellation from the tool runtime
 * @returns {Promise<object>} the fork with its head and whether it differs
 */
async function inspectFork(fork, upstreamHead, branch, token, signal) {
  const ref = await gh(`/repos/${fork.full_name}/git/ref/heads/${encodeURIComponent(branch)}`, token, signal)
  let head = null
  if (ref.ok && ref.data && ref.data.object) head = ref.data.object.sha
  const { size, created } = forkScore(fork)
  return {
    fullName: fork.full_name,
    head,
    sizeKb: size,
    createdAt: fork.created_at || null,
    pushedAt: fork.pushed_at || null,
    cloneUrl: fork.clone_url || null,
    htmlUrl: fork.html_url || null,
    differsFromUpstream: Boolean(head && upstreamHead && head !== upstreamHead),
    _created: created,
  }
}

async function mapLimit(items, limit, fn, signal) {
  const results = new Array(items.length)
  let next = 0
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      if (signal && signal.aborted) throw new Error('aborted')
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Register the read-only recovery tool.
 *
 * @param {object} ctx - Cordis context carrying the tool registry
 * @param {object} config - the row config from cordis.patch.yml
 */
export function apply(ctx, config) {
  const defaults = {
    token: readToken(config),
    maxForks: clampInt(config && config.maxForks, 1, 100, 30),
  }

  ctx.tools.register({
    name: 'github_repo_salvage',
    description:
      'Inspect a GitHub repository whose source was erased or whose history was force-pushed away, and find the forks that still hold the original commits. ' +
      'Read-only. Returns the current head, ref states recorded by the activity log, and fork candidates ranked by how much history they still carry. ' +
      'Pass expectedHead when you know the original commit SHA: a fork whose head equals it is a byte-identical copy of that tree.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['repo'],
      properties: {
        repo: {
          type: 'string',
          description: 'Target repository: owner/name, a github.com URL, or a git URL.',
        },
        maxForks: {
          type: 'integer',
          description: 'How many forks to inspect, 1-100. Defaults to the configured value, 30.',
        },
        expectedHead: {
          type: 'string',
          description: 'Optional commit SHA the recovered copy must match exactly. When given, each candidate reports match=true or match=false.',
        },
        includeForks: {
          type: 'boolean',
          description: 'Include every inspected fork in the result instead of only the candidates. Defaults to false.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          repo: { type: 'string' },
          archived: { type: 'boolean' },
          sizeKb: { type: 'integer' },
          defaultBranch: { type: 'string' },
          forkCount: { type: 'integer' },
          currentHead: { type: 'string' },
          activityHeads: { type: 'array', items: { type: 'string' } },
          candidates: { type: 'array', items: { type: 'object', additionalProperties: true } },
          others: { type: 'array', items: { type: 'object', additionalProperties: true } },
          recommended: { type: 'object', additionalProperties: true },
          notes: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const signal = exec && exec.signal ? exec.signal : undefined
      const { owner, repo } = parseRepo(args.repo)
      const full = `${owner}/${repo}`
      const maxForks = clampInt(args.maxForks, 1, 100, defaults.maxForks)
      const expectedHead = typeof args.expectedHead === 'string' ? args.expectedHead.trim() : ''
      const token = defaults.token

      const notes = []
      const result = {
        repo: full,
        archived: false,
        sizeKb: 0,
        defaultBranch: 'main',
        forkCount: 0,
        currentHead: null,
        activityHeads: [],
        candidates: [],
        others: [],
        recommended: null,
        notes,
      }

      const meta = await gh(`/repos/${full}`, token, signal)
      if (!meta.ok) {
        throw new Error(`GitHub answered ${meta.status} for ${full}: ${meta.message || 'no message'}`)
      }
      result.archived = Boolean(meta.data.archived)
      result.sizeKb = typeof meta.data.size === 'number' ? meta.data.size : 0
      result.defaultBranch = meta.data.default_branch || 'main'
      result.forkCount = typeof meta.data.forks_count === 'number' ? meta.data.forks_count : 0

      const head = await gh(`/repos/${full}/commits?per_page=1`, token, signal)
      if (head.ok && Array.isArray(head.data) && head.data.length > 0 && head.data[0].sha) {
        result.currentHead = head.data[0].sha
      }

      const activity = await gh(`/repos/${full}/activity?per_page=100`, token, signal)
      if (activity.ok && Array.isArray(activity.data)) {
        const seen = new Set()
        for (const row of activity.data) {
          for (const key of ['before', 'after']) {
            const sha = row && row[key]
            if (typeof sha === 'string' && sha.length === 40 && !ZERO_SHA.test(sha)) seen.add(sha)
          }
        }
        result.activityHeads = [...seen].slice(0, 20)
      } else if (activity.status === 404) {
        notes.push('activity log unavailable (404); fork inspection still works')
      }

      if (result.sizeKb <= 2) {
        notes.push('the repository is now nearly empty on disk; its files were likely removed by a force-push')
      }

      const forks = []
      for (let page = 1; page <= 3; page += 1) {
        const got = await gh(`/repos/${full}/forks?sort=oldest&per_page=100&page=${page}`, token, signal)
        if (!got.ok || !Array.isArray(got.data) || got.data.length === 0) break
        forks.push(...got.data)
        if (got.data.length < 100) break
      }

      if (forks.length === 0) {
        notes.push('no forks visible to this token; try again with a GITHUB_TOKEN that can read the network')
      }

      // Sort by creation time, not by size: the earliest forks were taken
      // before the rewrite, while a large fork often means its owner added
      // code later. Size only filters out empty repositories.
      const rank = forks
        .filter((f) => (typeof f.size === 'number' ? f.size : 0) > 2)
        .map((f) => ({ fork: f, ...forkScore(f) }))
        .sort((a, b) => a.created - b.created)
        .slice(0, maxForks)
        .map((x) => x.fork)

      if (rank.length === 0 && forks.length > 0) {
        notes.push('every fork is as small as the erased repository; none carries the old tree')
      }

      const inspected = await mapLimit(rank, 5, (fork) => inspectFork(fork, result.currentHead, result.defaultBranch, token, signal), signal)

      result.inspectedForks = inspected.length
      result.totalForks = forks.length

      for (const item of inspected) {
        const row = {
          fullName: item.fullName,
          head: item.head,
          sizeKb: item.sizeKb,
          createdAt: item.createdAt,
          pushedAt: item.pushedAt,
          cloneUrl: item.cloneUrl,
          htmlUrl: item.htmlUrl,
          differsFromUpstream: item.differsFromUpstream,
        }
        if (expectedHead) row.match = item.head === expectedHead
        if (item.differsFromUpstream || (expectedHead && item.head === expectedHead)) {
          result.candidates.push(row)
        } else {
          result.others.push(row)
        }
      }

      result.candidates.sort((a, b) => {
        if (expectedHead) {
          const am = a.match ? 1 : 0
          const bm = b.match ? 1 : 0
          if (am !== bm) return bm - am
        }
        // The earliest fork is the closest to the pre-rewrite state. A larger
        // size only means its owner added something afterwards, so it must not
        // outrank a plain snapshot of the original tree.
        return Date.parse(a.createdAt || '') - Date.parse(b.createdAt || '') || b.sizeKb - a.sizeKb
      })

      result.candidates = result.candidates.slice(0, 25)
      result.others = result.others.slice(0, 25)

      const best = result.candidates[0] || null
      if (best) {
        result.recommended = {
          fullName: best.fullName,
          head: best.head,
          cloneUrl: best.cloneUrl,
          verified: expectedHead ? best.head === expectedHead : null,
          command: `git clone ${best.cloneUrl || `https://github.com/${best.fullName}.git`}`,
          note: expectedHead
            ? best.head === expectedHead
              ? 'head matches the expected SHA; the tree is the original one'
              : 'head does not match the expected SHA; do not treat it as the original'
            : 'no expected SHA given; confirm the head before trusting the copy',
        }
      } else if (forks.length > 0) {
        notes.push('no fork differs from the current head: either every fork synced after the rewrite, or the code is gone from the network')
      }

      if (!args.includeForks) {
        if (result.others.length > 0) {
          notes.push(`${result.others.length} inspected fork(s) matched the current head and are omitted; pass includeForks=true to see them`)
        }
        result.others = []
      }

      return result
    },
  })
}
