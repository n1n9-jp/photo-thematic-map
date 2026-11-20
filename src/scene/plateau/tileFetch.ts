/**
 * 配信サーバーからタイルを取得するときの再試行と、失敗の集計。
 *
 * - タイルごとに、ネットワークの失敗・5xx・408・429 のときは間隔を指数的に延ばして再試行し、
 *   上限（既定 3 回）に達したら取得不能（TileUnavailableError）とする。404 などは「存在しない」（null）。
 * - 要求の失敗が続いたら（既定 6 回）、そのサーバーへの要求をしばらく止める（遮断）。
 *   止めている間に要求されたタイルは、要求を出さずに取得不能とする。間隔が過ぎたら 1 件だけ試し、
 *   成功すれば元に戻す。サーバーに届かないときに、表示範囲のタイル数 × 再試行回数の要求が出るのを防ぐ。
 * - 失敗はタイルごとにはコンソールへ出さず、`reportTileFailure` でまとめて 1 件の警告にする。
 */

/** 上限まで再試行しても取得できなかった（または遮断中で要求しなかった）。 */
export class TileUnavailableError extends Error {
  constructor(url: string, cause?: unknown) {
    super(`タイルを取得できません: ${url}`, { cause });
    this.name = 'TileUnavailableError';
  }
}

export interface TileFetchPolicyOptions {
  /** 1 タイルあたりの要求回数の上限（最初の 1 回を含む）。既定 3。 */
  maxAttempts?: number;
  /** 再試行の最初の待ち時間(ms)。2 回目以降は倍にする。既定 1000。 */
  baseDelayMs?: number;
  /** 再試行の待ち時間の上限(ms)。既定 8000。 */
  maxDelayMs?: number;
  /** 要求の失敗がこの回数続いたら要求を止める。既定 6。 */
  breakerThreshold?: number;
  /** 要求を止める時間(ms)。止めるたびに倍にする（上限 5 分）。既定 30000。 */
  breakerCooldownMs?: number;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_COOLDOWN_MS = 5 * 60_000;

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 1 つの配信元（航空写真・標高・建物など）への要求の出し方。 */
export class TileFetchPolicy {
  /** 取得不能になったタイルの件数。 */
  failedCount = 0;

  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly breakerThreshold: number;
  private readonly baseCooldownMs: number;
  private consecutiveFailures = 0;
  private cooldownMs: number;
  private blockedUntil = 0;
  private probing = false;

  constructor(
    /** 失敗をまとめて報告するときの名前（例: 航空写真）。 */
    readonly label: string,
    options: TileFetchPolicyOptions = {},
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 8000;
    this.breakerThreshold = options.breakerThreshold ?? 6;
    this.baseCooldownMs = options.breakerCooldownMs ?? 30_000;
    this.cooldownMs = this.baseCooldownMs;
  }

  /** 要求を止めているか。 */
  get blocked(): boolean {
    return this.tripped && (Date.now() < this.blockedUntil || this.probing);
  }

  private get tripped(): boolean {
    return this.consecutiveFailures >= this.breakerThreshold;
  }

  /**
   * url を取得する。成功なら Response、存在しない（404 など）なら null。
   * 取得不能なら TileUnavailableError、signal で中止されたら AbortError を投げる。
   */
  async fetch(url: string, init: RequestInit = {}): Promise<Response | null> {
    const signal = init.signal ?? undefined;
    let attempts = this.maxAttempts;
    let probe = false;
    if (this.tripped) {
      if (this.blocked) return this.fail(url);
      // 止める時間が過ぎた: 1 件だけ 1 回試す
      this.probing = true;
      probe = true;
      attempts = 1;
    }
    try {
      let lastError: unknown;
      for (let i = 0; i < attempts; i++) {
        if (i > 0) {
          await sleep(Math.min(this.baseDelayMs * 2 ** (i - 1), this.maxDelayMs), signal);
          // 待っている間に、ほかのタイルの失敗で要求を止めたなら再試行しない
          if (this.blocked) break;
        }
        try {
          const res = await this.fetchImpl(url, init);
          if (res.ok) return this.succeed(res);
          if (!RETRYABLE_STATUS.has(res.status)) {
            // 存在しないタイル（範囲外・海域など）。サーバーには届いている
            this.succeed(res);
            return null;
          }
          lastError = new Error(`HTTP ${res.status}`);
        } catch (err) {
          if (isAbort(err) || signal?.aborted) throw err;
          lastError = err;
        }
        this.requestFailed();
      }
      return this.fail(url, lastError);
    } finally {
      if (probe) this.probing = false;
    }
  }

  /** 失敗の記録を消して、要求の停止を解く（地図を読み直すとき用）。 */
  reset(): void {
    this.failedCount = 0;
    this.consecutiveFailures = 0;
    this.blockedUntil = 0;
    this.cooldownMs = this.baseCooldownMs;
  }

  private succeed(res: Response): Response {
    this.consecutiveFailures = 0;
    this.cooldownMs = this.baseCooldownMs;
    return res;
  }

  /** 要求が 1 回失敗した。連続して閾値に達したら、しばらく要求を止める。 */
  private requestFailed(): void {
    this.consecutiveFailures++;
    if (this.tripped && Date.now() >= this.blockedUntil) {
      this.blockedUntil = Date.now() + this.cooldownMs;
      this.cooldownMs = Math.min(this.cooldownMs * 2, MAX_COOLDOWN_MS);
    }
  }

  private fail(url: string, cause?: unknown): never {
    this.failedCount++;
    reportTileFailure(this.label);
    throw new TileUnavailableError(url, cause);
  }
}

/** まとめて報告するまで待つ時間(ms)。 */
const REPORT_DELAY_MS = 3000;
const pendingFailures = new Map<string, number>();
let reportTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 取得不能のタイルを 1 件記録する。少し待ってから、それまでの分をまとめて 1 件の警告として出す。
 */
export function reportTileFailure(label: string): void {
  pendingFailures.set(label, (pendingFailures.get(label) ?? 0) + 1);
  reportTimer ??= setTimeout(flushTileFailures, REPORT_DELAY_MS);
}

function flushTileFailures(): void {
  reportTimer = null;
  if (pendingFailures.size === 0) return;
  const parts = [...pendingFailures].map(([label, n]) => `${label} ${n} 件`);
  pendingFailures.clear();
  console.warn(`地図のタイルの一部を読み込めませんでした（${parts.join('、')}）。配信サーバーに接続できない可能性があります。`);
}
