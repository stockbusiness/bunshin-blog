/**
 * 外向きHTTPの公開インターフェース（TASKS C-7）。
 *
 * **サーバー専用。** `node:http` / `node:dns` を使うため、ブラウザ向けの
 * コードから import しない（MODULE_RULES 4）。
 *
 * **利用者が宛先を決められるリクエストは必ず `safeFetch` を通す**
 * （SPEC 14.3）。`fetch` を直接呼ばない。
 */

export {
  safeFetch,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDIRECTS,
  type SafeFetchOptions,
  type SafeFetchResponse,
} from './safe-fetch';

export {
  HTTP_ERROR_CODES,
  HttpFetchError,
  isHttpFetchError,
  type HttpErrorCode,
} from './errors';

export {
  classifyAddress,
  isBlockedAddress,
  parseIpv4,
  parseIpv6,
  type AddressVerdict,
} from './address';

export {
  assertFetchableUrl,
  resolveAllowedAddress,
  resolveRedirectTarget,
  type HostLookup,
  type ResolvedAddress,
} from './url-guard';

export {
  nodeHttpTransport,
  type HttpTransport,
  type HttpRequestInput,
  type HttpRawResponse,
} from './transport';
