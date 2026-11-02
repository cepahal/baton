/**
 * The team server's login form. It posts the token as JSON to `/login`, which
 * sets the viewer cookie, so the token never appears in a URL or history.
 */
export const LOGIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Baton — sign in</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { display: grid; place-items: center; min-height: 100vh; margin: 0; }
  form { display: grid; gap: 0.75rem; width: min(22rem, 90vw); }
  h1 { font-size: 1.25rem; margin: 0; }
  input, button { font: inherit; padding: 0.5rem 0.75rem; }
  p { margin: 0; min-height: 1.5em; color: #c0392b; }
</style>
</head>
<body>
<form id="login">
  <h1>Baton team server</h1>
  <label for="token">Team token</label>
  <input id="token" name="token" type="password" autocomplete="current-password" required autofocus>
  <button type="submit">Sign in</button>
  <p id="error" role="alert"></p>
</form>
<script>
  const form = document.getElementById("login");
  const error = document.getElementById("error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    const token = document.getElementById("token").value;
    const res = await fetch("/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }).catch(() => undefined);
    if (res && res.ok) location.assign("/");
    else error.textContent = res && res.status === 401 ? "Wrong token." : "Could not reach the server.";
  });
</script>
</body>
</html>
`;
