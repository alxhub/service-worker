export class MockBody implements Body {
  bodyUsed: boolean = false;

  constructor(public _body: string|null) {}

  async arrayBuffer(): Promise<ArrayBuffer> {
    throw 'Not implemented';
  }

  async blob(): Promise<Blob> {
    throw 'Not implemented';
  }

  async json(): Promise<any> {
    this.bodyUsed = true;
    if (this._body !== null) {
      return JSON.parse(this._body);
    } else {
      throw new Error('No body');
    }
  }

  async text(): Promise<string> {
    this.bodyUsed = true;
    if (this._body !== null) {
      return this._body;
    } else {
      throw new Error('No body');
    }
  }

  async formData(): Promise<FormData> {
    throw 'Not implemented';
  }
}

export class MockRequest extends MockBody implements Request {
  readonly cache: RequestCache = 'default';
  readonly credentials: RequestCredentials = 'omit';
  readonly destination: RequestDestination = 'document';
  readonly headers: Headers = null!;
  readonly integrity: string = '';
  readonly keepalive: boolean = true;
  readonly method: string = 'GET'
  readonly mode: RequestMode = 'cors';
  readonly redirect: RequestRedirect = 'error';
  readonly referrer: string = '';
  readonly referrerPolicy: ReferrerPolicy = 'no-referrer';
  readonly type: RequestType = '';
  readonly url: string;

  constructor(input: string | Request, init?: RequestInit) {
    super(init !== undefined ? init.body || null : null);
    if (typeof input !== 'string') {
      throw 'Not implemented';
    }
    this.url = input;
  }

  clone(): Request {
    if (this.bodyUsed) {
      throw 'Body already consumed';
    }
    return new MockRequest(this.url, {body: this._body});
  }
}

export class MockResponse extends MockBody implements Response {
  readonly headers: Headers = null!;
  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }
  readonly status: number;
  readonly statusText: string;
  readonly type: ResponseType = 'basic';
  readonly url: string = '';
  readonly body: ReadableStream|null = null;

  constructor(body?: any, init: ResponseInit = {}) {
    super(typeof body === 'string' ? body : null);
    this.status = (init.status !== undefined) ? init.status : 200;
    this.statusText = init.statusText || 'OK';
  }

  clone(): Response {
    if (this.bodyUsed) {
      throw 'Body already consumed';
    }
    return new MockResponse(this._body, {status: this.status, statusText: this.statusText})
  }
}