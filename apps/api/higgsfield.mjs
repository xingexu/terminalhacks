import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { requireCondition as check } from '../../packages/runtime/memory.mjs';

const serverUrl = 'https://mcp.higgsfield.ai/mcp';
const scope = 'openid email offline_access';

class Account {
  constructor(dir, actor) {
    this.file = join(dir, actor + '.json');
    this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
  }
  save(patch) {
    Object.assign(this.data, patch);
    const temporary = this.file + '.' + randomBytes(8).toString('hex');
    writeFileSync(temporary, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
  get redirectUrl() { return this.data.redirectUrl; }
  get clientMetadata() {
    return { client_name: 'Everwhere', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none', scope };
  }
  state() { return this.data.nonce; }
  clientInformation() { return this.data.client; }
  saveClientInformation(client) { this.save({ client }); }
  tokens() { return this.data.tokens; }
  saveTokens(tokens) { this.save({ tokens }); }
  saveCodeVerifier(verifier) { this.save({ verifier }); }
  codeVerifier() { return this.data.verifier; }
  discoveryState() { return this.data.discovery; }
  saveDiscoveryState(discovery) { this.save({ discovery }); }
  redirectToAuthorization(url) {
    check(this.interactive, 401, 'HIGGSFIELD_AUTH', 'Reconnect Higgsfield to continue.');
    this.authorizationUrl = url.href;
  }
  invalidateCredentials(kind) {
    const patch = {};
    if (['all', 'client'].includes(kind)) patch.client = undefined;
    if (['all', 'tokens'].includes(kind)) patch.tokens = undefined;
    if (['all', 'verifier'].includes(kind)) patch.verifier = undefined;
    if (['all', 'discovery'].includes(kind)) patch.discovery = undefined;
    this.save(patch);
  }
}

export function createHiggsfield(dataDir) {
  const directory = join(dataDir, 'provider-accounts');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const accounts = new Map();
  function account(actor) {
    if (!accounts.has(actor)) accounts.set(actor, new Account(directory, actor));
    return accounts.get(actor);
  }
  return {
    status(actor) {
      const data = account(actor).data;
      return { connected: Boolean(data.tokens?.access_token), account: data.account };
    },
    async begin(actor, origin, returnPath) {
      const provider = account(actor);
      const redirectUrl = new URL('/v1/higgsfield/callback', origin).href;
      if (provider.redirectUrl !== redirectUrl) provider.invalidateCredentials('all');
      provider.save({ redirectUrl, returnPath, nonce: randomBytes(32).toString('base64url'), loginExpires: Date.now() + 10 * 60_000 });
      provider.interactive = true;
      try {
        const result = await auth(provider, { serverUrl, scope });
        return result === 'AUTHORIZED' ? returnPath : provider.authorizationUrl;
      } finally { provider.interactive = false; }
    },
    async finish(actor, code, state) {
      const provider = account(actor);
      check(typeof code === 'string' && typeof state === 'string' && state === provider.data.nonce && provider.data.loginExpires > Date.now(),
        400, 'OAUTH_STATE', 'This sign-in expired. Open the scene panel and connect again.');
      const exchange = Object.create(provider);
      exchange.saveTokens = tokens => {
        check(provider.data.nonce === state, 400, 'OAUTH_STATE', 'A newer sign-in replaced this request.');
        provider.saveTokens(tokens);
      };
      const result = await auth(exchange, { serverUrl, scope, authorizationCode: code });
      check(result === 'AUTHORIZED', 401, 'HIGGSFIELD_AUTH', 'Higgsfield authorization did not finish.');
      const identity = await fetch('https://higgsfield.ai/_clerk/oauth/userinfo', {
        headers: { Authorization: 'Bearer ' + provider.data.tokens.access_token }, signal: AbortSignal.timeout(15000), redirect: 'error'
      });
      const profile = identity.ok ? await identity.json() : {};
      provider.save({ account: profile.preferred_username || profile.name || 'Higgsfield account', nonce: undefined, verifier: undefined, loginExpires: undefined });
      return provider.data.returnPath;
    },
    disconnect(actor) { const provider = account(actor); provider.invalidateCredentials('all'); provider.save({ account: undefined, nonce: undefined }); },
    async connect(actor) {
      const provider = account(actor);
      check(provider.tokens()?.access_token, 401, 'HIGGSFIELD_AUTH', 'Connect Higgsfield before generating a scene.');
      const client = new Client({ name: 'everwhere', version: '0.1.0' });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider }));
      } catch {
        await client.close().catch(() => {});
        check(false, 502, 'HIGGSFIELD_CONNECTION', 'Higgsfield could not be reached. Check the connection and try again.');
      }
      return {
        close: () => client.close(),
        async call(name, args) {
          const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
          check(!result.isError, 502, 'HIGGSFIELD_REQUEST', 'Higgsfield could not complete the scene operation. Reconnect or try again.');
          if (result.structuredContent) return result.structuredContent;
          for (const content of result.content ?? []) {
            if (content.type !== 'text') continue;
            try { return JSON.parse(content.text); } catch { /* Some tools include explanatory text before the JSON result. */ }
          }
          check(false, 502, 'HIGGSFIELD_RESPONSE', 'Higgsfield returned an unreadable scene result.');
        }
      };
    }
  };
}
