# OptiVolt 🔋

**OptiVolt** is a solver that finds the most efficient energy plan for your home.

It uses linear programming to decide — every 15 minutes — how your battery, EV, heat pump, and the grid should interact.
Feed it your load, solar forecast, and tariffs, and it returns a day-long schedule that minimizes cost and peaks.

### Planned features
- Fast linear and mixed-integer optimization using [HiGHS](https://github.com/ERGO-Code/HiGHS)
- Models power balance, battery dynamics, peak tariffs, and efficiency losses
- Works in Node or browser (WASM)
- Designed for integration with Home Assistant or custom dashboards
- Transparent LP format output — no black boxes, just math you can read

### Roadmap
- [x] Basic battery model
- [x] Time-of-use tariffs
- [x] Solar PV support
- [x] Battery cost
- [x] Terminal state of charge
- [x] html frontend
- [x] Fetch predictions from Victron
- [ ] Add experimental optimizer tweaks
- [ ] Express API
- [ ] Convert plan to Victron commands
- [ ] EV charging model
- [ ] Heat pump model

## Using a Cloudflare Worker as a CORS proxy

Browsers block direct calls to the Victron **VRM API** from this app because the VRM servers don’t include permissive **CORS** headers. To call the API client-side, run a tiny proxy on your own domain that forwards requests to VRM and adds CORS headers or use the default proxy.

### Quick setup

1. Open **Cloudflare Dashboard → Workers & Pages → Create → Worker**.
2. Replace the boilerplate with the code below.
3. **Deploy** and copy your Worker URL (e.g. `https://vrm-cors-proxy.example.workers.dev`).
4. In the app’s **Victron VRM** section, set **Proxy base URL** to your Worker URL.

#### Worker code

```js
export default {
  async fetch(req) {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }

    const url = new URL(req.url);
    // Forward to VRM origin;
    const target = new URL(`https://vrmapi.victronenergy.com${url.pathname}${url.search}`);

    const init = {
      method: req.method,
      headers: new Headers(req.headers),
      body: ['GET','HEAD'].includes(req.method) ? undefined : await req.arrayBuffer(),
      redirect: 'follow',
    };

    // Remove hop-by-hop / problematic headers
    init.headers.delete('host');
    init.headers.delete('origin');

    const upstream = await fetch(target.toString(), init);

    const respHeaders = new Headers(upstream.headers);
    corsHeaders(req, respHeaders); // add permissive CORS

    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  }
};

function corsHeaders(req, h = new Headers()) {
  const origin = req.headers.get('Origin') || '*';
  h.set('Access-Control-Allow-Origin', origin);
  h.set('Vary', 'Origin');
  h.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'X-Authorization, Content-Type');
  h.set('Access-Control-Max-Age', '86400');
  return h;
}
```
