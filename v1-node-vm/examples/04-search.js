// The sandbox doesn't need to know every tool up front: it can search.
const found = await search({ query: "note" });
console.log("found:", found.items.map((t) => t.path));
return found;
