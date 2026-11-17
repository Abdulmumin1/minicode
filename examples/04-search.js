// The program doesn't need the whole catalog up front: it can search.
const found = search("note");
console.log(found.items.map((t) => t.signature).join("\n\n"));

await tools.notes.save({ title: "today", body: "Built a JavaScript interpreter." });
const titles = await tools.notes.list();
return Promise.all(titles.map(async (title) => ({ title, body: await tools.notes.read({ title }) })));
