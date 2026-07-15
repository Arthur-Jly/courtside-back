/**
 * Monte une app Express sur un port éphémère et renvoie { server, url }.
 * Toujours fermer dans un finally : `finally { server.close(); }`.
 */
function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

/** POST JSON minimal. */
function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

module.exports = { listen, postJson };
