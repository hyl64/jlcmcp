const TIMEOUT_MS = 120_000;

export class ServiceClient {
  private placementUrl: string;
  private routingUrl: string;
  private converterUrl: string;

  constructor() {
    this.placementUrl = process.env.PLACEMENT_URL ?? 'http://127.0.0.1:18810';
    this.routingUrl = process.env.ROUTING_URL ?? 'http://127.0.0.1:18820';
    this.converterUrl = process.env.CONVERTER_URL ?? 'http://127.0.0.1:18840';
  }

  private async post(url: string, body: unknown): Promise<unknown> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json();
  }

  private async get(url: string): Promise<unknown> {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async place(irData: unknown, engine = 'auto', options = {}): Promise<unknown> {
    return this.post(`${this.placementUrl}/place`, { ir_data: irData, engine, options });
  }

  async route(irData: unknown, options = {}): Promise<unknown> {
    return this.post(`${this.routingUrl}/route`, { ir_data: irData, options });
  }

  async convert(data: string, fromFormat: string, toFormat: string, extra: Record<string, string> = {}): Promise<unknown> {
    return this.post(`${this.converterUrl}/convert`, { data, from_format: fromFormat, to_format: toFormat, ...extra });
  }

  async healthAll(): Promise<Record<string, unknown>> {
    const check = async (name: string, url: string) => {
      try {
        const data = await this.get(`${url}/health`);
        return { name, status: 'ok', data };
      } catch (e: any) {
        return { name, status: 'error', error: e.message };
      }
    };
    const results = await Promise.all([
      check('placement', this.placementUrl),
      check('routing', this.routingUrl),
      check('converter', this.converterUrl),
    ]);
    return Object.fromEntries(results.map(r => [r.name, { status: r.status, ...(r.data ? { data: r.data } : {}), ...(r.error ? { error: r.error } : {}) }]));
  }
}
