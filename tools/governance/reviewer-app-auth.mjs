import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const appId = 5487224;
const installationId = 175625005;
const repositoryId = 1427426748;
const clientId = 'Iv23ctaEdWaFhBYqhbZg';
const slug = 'glyad-workspace-reviewer';
const granted = { contents: 'read', metadata: 'read', pull_requests: 'write' };
const readonly = { contents: 'read', metadata: 'read', pull_requests: 'read' };
const limit = 65_536;
const validCredential = (value) => typeof value === 'string' && /^[\x21-\x7e]{1,8192}$/.test(value);
const account = (value) => value?.id === 4238205 && value?.login === 'glyad';
function permissions(value, expected, implicitMetadata = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = { ...value };
  if (implicitMetadata && !Object.hasOwn(actual, 'metadata')) actual.metadata = 'read';
  return (
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, permission]) => actual[key] === permission)
  );
}
function repositories(value) {
  return (
    Array.isArray(value) &&
    value.length === 1 &&
    value[0]?.id === repositoryId &&
    value[0]?.full_name === 'glyad/github-workspace-manager' &&
    account(value[0]?.owner)
  );
}

// Only locally constructed failures may become public diagnostic text.
class AuthCheckError extends Error {}
class RequestFailure extends AuthCheckError {
  constructor(phase, kind, status) {
    super(
      kind === 'HTTP'
        ? `${phase}: HTTP ${status}`
        : `${phase}: ${kind}${status === null ? '' : ` (HTTP ${status})`}`,
    );
  }
}
export function safeAuthError(error) {
  return error instanceof AuthCheckError ? error.message : 'Authentication check failed';
}
const requestPhases = Object.freeze({
  '/app': 'app',
  [`/app/installations/${installationId}`]: 'installation',
  [`/app/installations/${installationId}/access_tokens`]: 'token-issuance',
  '/installation/repositories': 'repository-read',
  '/installation/token': 'token-revocation',
});

// One bounded request, including body reads. No redirects or mutation retries.
async function request(fetchImpl, method, path, credential, body, expectedStatus) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let response;
  let status = null;
  let kind = 'transport failure';
  try {
    response = await fetchImpl(`https://api.github.com${path}`, {
      method,
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${credential}`,
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'glyad-workspace-reviewer-auth-check',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    kind = 'response failure';
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599)
      throw Error();
    status = response.status;
    if (response.redirected || (status >= 300 && status < 400)) {
      kind = 'redirect rejected';
      throw Error();
    }
    if (status !== expectedStatus) {
      kind = 'HTTP';
      throw Error();
    }
    if (expectedStatus === 204) return null;
    kind = 'read failure';
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        kind = 'response limit exceeded';
        throw Error();
      }
      chunks.push(Buffer.from(value));
    }
    kind = 'parse failure';
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestFailure(requestPhases[path], kind, status);
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Error response bodies are never read or included in diagnostics.
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}

export async function runAuthCheck({
  privateKey,
  fetchImpl = globalThis.fetch,
  mask = () => {},
  diagnostic = () => {},
  now = Date.now,
} = {}) {
  let jwt;
  let fingerprint;
  try {
    const key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== 'rsa') throw Error();
    fingerprint =
      'SHA256:' +
      createHash('sha256')
        .update(createPublicKey(key).export({ type: 'spki', format: 'der' }))
        .digest('base64');
    const time = Math.floor(now() / 1000);
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const message = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: time - 60, exp: time + 540, iss: clientId })}`;
    jwt = `${message}.${sign('RSA-SHA256', Buffer.from(message), key).toString('base64url')}`;
  } catch {
    throw new AuthCheckError('JWT creation failed');
  }
  mask(jwt);
  diagnostic(`Public key fingerprint ${fingerprint}`);
  const app = await request(fetchImpl, 'GET', '/app', jwt, null, 200);
  if (
    app?.id !== appId ||
    app?.client_id !== clientId ||
    app?.slug !== slug ||
    !account(app?.owner) ||
    !permissions(app?.permissions, granted)
  )
    throw new AuthCheckError('App identity or permissions mismatch');
  const installation = await request(
    fetchImpl,
    'GET',
    `/app/installations/${installationId}`,
    jwt,
    null,
    200,
  );
  if (
    installation?.id !== installationId ||
    installation?.app_id !== appId ||
    installation?.app_slug !== slug ||
    !account(installation?.account) ||
    installation?.repository_selection !== 'selected' ||
    installation?.suspended_at !== null ||
    installation?.suspended_by !== null ||
    !permissions(installation?.permissions, granted)
  )
    throw new AuthCheckError('Installation identity or grant mismatch');

  let token;
  let failure;
  const failures = [];
  try {
    const issued = await request(
      fetchImpl,
      'POST',
      `/app/installations/${installationId}/access_tokens`,
      jwt,
      { repository_ids: [repositoryId], permissions: { contents: 'read', pull_requests: 'read' } },
      201,
    );
    // Capture before validating restrictions so all received usable tokens are revoked.
    if (!validCredential(issued?.token)) throw new AuthCheckError('Token issuance uncertain');
    token = issued.token;
    mask(token);
    if (
      issued.repository_selection !== 'selected' ||
      !permissions(issued.permissions, readonly, true) ||
      !repositories(issued.repositories) ||
      !Number.isFinite(Date.parse(issued.expires_at)) ||
      Date.parse(issued.expires_at) <= now()
    )
      throw new AuthCheckError('Token restrictions mismatch');
    const observed = await request(
      fetchImpl,
      'GET',
      '/installation/repositories',
      token,
      null,
      200,
    );
    if (observed?.total_count !== 1 || !repositories(observed?.repositories))
      throw new AuthCheckError('Repository readback mismatch');
  } catch (error) {
    if (error instanceof RequestFailure) failures.push(error.message);
    // Only fixed local messages escape; never forward fetch/crypto exceptions.
    failure = token
      ? ['Token restrictions mismatch', 'Repository readback mismatch'].includes(error.message)
        ? error.message
        : 'Installation read failed'
      : 'Token issuance uncertain';
  } finally {
    if (token) {
      try {
        await request(fetchImpl, 'DELETE', '/installation/token', token, null, 204);
      } catch (error) {
        if (error instanceof RequestFailure) failures.push(error.message);
        failure = failure ? `${failure}; token revocation failed` : 'Token revocation failed';
      }
    } else {
      failure = 'Token issuance uncertain; no usable token received for revocation';
    }
  }
  if (failure)
    throw new AuthCheckError(`${failure}${failures.length ? ` [${failures.join('; ')}]` : ''}`);
  return { appId, installationId, repositoryId, permissions: readonly, revoked: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (
      process.env.GITHUB_ACTIONS !== 'true' ||
      process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
      process.env.GITHUB_REF !== 'refs/heads/main' ||
      process.env.GITHUB_REPOSITORY !== 'glyad/github-workspace-manager'
    ) {
      throw new AuthCheckError('Trusted manual main execution required');
    }
    const privateKey = process.env.REVIEWER_APP_PRIVATE_KEY;
    delete process.env.REVIEWER_APP_PRIVATE_KEY;
    const summary = await runAuthCheck({
      privateKey,
      mask: (value) => console.log(`::add-mask::${value}`),
      diagnostic: (value) => console.log(value),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    console.error(safeAuthError(error));
    process.exitCode = 1;
  }
}
