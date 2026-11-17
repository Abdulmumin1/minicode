// The reason Code Mode exists: one program makes many tool calls, in
// parallel, and only the small answer goes back to the model.
// Watch the timeline: 6 profile lookups overlap instead of running one by one.
const ids = await tools.users.find({ country: "ng" });
const profiles = await Promise.all(ids.map((id) => tools.users.get({ id })));

const pro = profiles.filter((u) => u.plan === "pro");
const top = profiles.toSorted((a, b) => b.spend - a.spend)[0];

return { users: profiles.length, pro: pro.map((u) => u.name), topSpender: top.name };
