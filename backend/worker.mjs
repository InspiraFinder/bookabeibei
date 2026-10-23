import { handleApi } from './api.mjs';
import { secure } from './security.mjs';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return secure(await handleApi(request, env));
    return secure(await env.ASSETS.fetch(request));
  },
};
