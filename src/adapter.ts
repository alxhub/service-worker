export class Adapter {
  newRequest(input: string|Request, init?: RequestInit): Request {
    return new Request(input, init);
  }

  newResponse(body: any, init?: ResponseInit) {
    return new Response(body, init);
  }

  get time(): number {
    return Date.now();
  }

  timeout(ms: number): Promise<void> {
    return new Promise(resolve => {
      setTimeout(resolve, ms);
    });
  }
}

export interface Context {
  waitUntil(fn: Promise<any>): void;
}