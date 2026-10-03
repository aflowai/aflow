/**
 * The page the sign-in sitting opens on. A `data:` address, so showing it
 * reaches no network and passes through no proxy.
 */
const HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="color-scheme" content="light dark">',
  '<title>Sign in to sites</title>',
  '<style>',
  'body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1.5rem}',
  'h1{font-size:1.4rem;margin:0 0 1rem}',
  '</style>',
  '</head>',
  '<body>',
  '<h1>This is the agent’s own browser on this machine.</h1>',
  '<p>Sign in here to whatever the agent should reach. The sign-ins stay in this browser, for the agent to use.</p>',
  '<p>Close this window when you are done.</p>',
  '<p>Nothing of your everyday browser is here: none of its sign-ins, history or saved passwords.</p>',
  '</body>',
  '</html>',
].join('');

export const SIGN_IN_START_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`;
