export class Adapter {
  newRequest(input: string|Request, init?: RequestInit): Request {
    return new Request(input, init);
  }

  newResponse(body: any, init?: ResponseInit) {
    return new Response(body, init);
  }
}
