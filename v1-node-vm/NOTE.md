# v1: node:vm, kept for comparison

This was my first sandbox: guest code in a `node:vm` context, inside a worker thread.

It isn't safe. `globalThis.constructor.constructor("return process")()` reached the worker's real `process` on the first try. Node 22's `vm.constants.DONT_CONTEXTIFY` closed that path, and creating every guest-visible object inside the context closed the others I knew of. But Node's own docs say `vm` is not a security mechanism, and every path has to be found by hand.

The runtime worth reading is in [../src](../src). The story is in [the post](https://yaqeen.me/blog/i-built-a-code-mode-sandbox).
