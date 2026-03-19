/**
 * Rate Limiter con Token Bucket para APIs externas.
 *
 * Cada servicio tiene su propio bucket con:
 *   - maxTokens: capacidad máxima del bucket
 *   - refillRate: cuántos tokens se agregan por intervalo
 *   - refillIntervalMs: cada cuánto se agregan tokens
 *
 * Cuando un caller hace acquire(), espera hasta que haya tokens disponibles.
 */

interface RateLimiterConfig {
  maxTokens: number;
  refillRate: number;
  refillIntervalMs: number;
}

class RateLimiter {
  readonly name: string;
  private maxTokens: number;
  private tokens: number;
  private refillRate: number;
  private refillIntervalMs: number;
  private lastRefill: number;
  private queue: Array<() => void>;

  constructor(name: string, { maxTokens, refillRate, refillIntervalMs }: RateLimiterConfig) {
    this.name = name;
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRate = refillRate;
    this.refillIntervalMs = refillIntervalMs;
    this.lastRefill = Date.now();
    this.queue = [];
  }

  private _refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = Math.floor(elapsed / this.refillIntervalMs) * this.refillRate;
    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
      this.lastRefill = now;
    }
  }

  private _processQueue(): void {
    while (this.queue.length > 0) {
      this._refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        const resolve = this.queue.shift()!;
        resolve();
      } else {
        // Programar siguiente intento
        const waitMs = this.refillIntervalMs;
        setTimeout(() => this._processQueue(), waitMs);
        break;
      }
    }
  }

  /**
   * Adquiere un token. Retorna una Promise que se resuelve cuando hay capacidad.
   */
  acquire(): Promise<void> {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      const waitMs = this.refillIntervalMs;
      setTimeout(() => this._processQueue(), waitMs);
    });
  }

  /**
   * Intenta adquirir sin esperar. Retorna true si había capacidad.
   */
  tryAcquire(): boolean {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

interface Limiters {
  deepseek: RateLimiter;
  gemini: RateLimiter;
  metaApi: RateLimiter;
  twitter: RateLimiter;
  googleDrive: RateLimiter;
  imageGen: RateLimiter;
  webSearch: RateLimiter;
}

// Limiters por servicio con defaults conservadores
export const limiters: Limiters = {
  deepseek:    new RateLimiter("deepseek",    { maxTokens: 10, refillRate: 1, refillIntervalMs: 6000 }),    // ~10 req/min
  gemini:      new RateLimiter("gemini",      { maxTokens: 15, refillRate: 1, refillIntervalMs: 4000 }),    // ~15 req/min
  metaApi:     new RateLimiter("metaApi",     { maxTokens: 5,  refillRate: 1, refillIntervalMs: 12000 }),   // ~5 req/min
  twitter:     new RateLimiter("twitter",     { maxTokens: 3,  refillRate: 1, refillIntervalMs: 60000 }),   // ~3 req/min
  googleDrive: new RateLimiter("googleDrive", { maxTokens: 10, refillRate: 1, refillIntervalMs: 6000 }),    // ~10 req/min
  imageGen:    new RateLimiter("imageGen",    { maxTokens: 3,  refillRate: 1, refillIntervalMs: 20000 }),   // ~3 req/min
  webSearch:   new RateLimiter("webSearch",   { maxTokens: 10, refillRate: 1, refillIntervalMs: 6000 }),    // ~10 req/min
};

export { RateLimiter };
export type { RateLimiterConfig };
