// The password the program ships with.
//
// Every copy knows admin123 and it is printed in the instructions, so until it
// is changed it protects nothing. The program has to notice and insist.
//
//     node electron/test/first-password.js

import { freshApp, reporter } from "./harness.js";
const app = freshApp(); const r = reporter("THE FIRST PASSWORD"); const call = app.call;

const first = call("POST", "/api/login", { username: "admin", password: "admin123" });
r.check("signing in with the shipped password works", first.user.username === "admin");
r.check("but the program says it must be changed", first.must_change_password === true,
  String(first.must_change_password));
r.check("and says so again if the window is reopened",
  call("GET", "/api/me").must_change_password === true);

call("POST", "/api/me/password", { current_password: "admin123", new_password: "usman2026" });
r.check("after choosing one, it stops asking",
  call("GET", "/api/me").must_change_password === false,
  String(call("GET", "/api/me").must_change_password));
const after = call("POST", "/api/login", { username: "admin", password: "usman2026" });
r.check("the new password works", after.user.username === "admin");
r.check("and it is not flagged", after.must_change_password === false);
let refused = false;
try { call("POST", "/api/login", { username: "admin", password: "admin123" }); }
catch (e) { refused = true; }
r.check("the shipped password no longer works", refused);

const staff = call("POST", "/api/users", { username: "counter", password: "counter99", role: "staff" });
r.check("a new person is not nagged about a password they chose",
  call("POST", "/api/login", { username: "counter", password: "counter99" })
    .must_change_password === false);
app.cleanup(); r.finish();
