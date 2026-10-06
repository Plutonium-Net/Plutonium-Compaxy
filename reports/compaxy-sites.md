# Compaxy site conformance check

Base: `http://127.0.0.1:5221`  
Run: 2026-10-06T04:40:28.541Z

Verdicts: 21 ok, 2 challenge

```text
site          verdict  doc      rewritten  assets     note
------------------------------------------------------------------------------
Discord       challenge 200      yes        -          Cloudflare challenge - a real browser may still clear this, since the challenge is solved by JavaScript that only the browser runs
Claude        challenge 200      yes        -          Cloudflare challenge - a real browser may still clear this, since the challenge is solved by JavaScript that only the browser runs
YouTube       ok       200      yes        8/8        
Twitch        ok       200      yes        8/8        
Netflix       ok       200      yes        8/8        
Disney+       ok       200      yes        8/8        
Spotify       ok       200      yes        8/8        
Apple Music   ok       200      yes        8/8        
SoundCloud    ok       200      yes        8/8        
Reddit        ok       200      yes        2/2        
X             ok       200      yes        8/8        
Instagram     ok       200      yes        8/8        
TikTok        ok       200      yes        8/8        
Pinterest     ok       200      yes        8/8        
GitHub        ok       200      yes        8/8        
Roblox        ok       200      yes        8/8        
Google        ok       200      yes        8/8        
DuckDuckGo    ok       200      yes        8/8        
ChatGPT       ok       200      yes        8/8        
Duck.ai       ok       200      yes        8/8        
Wikipedia     ok       200      yes        8/8        
Steam         ok       200      yes        8/8        
GeForce NOW   ok       200      yes        8/8        
```

## YouTube — ok

- target: https://www.youtube.com/
- document: HTTP 200, text/html; charset=utf-8, 909000 bytes, 1 redirect hop(s)
- mirrored at: `http://127.0.0.1:5221/proxy/https/www.youtube.com/`

## Twitch — ok

- target: https://www.twitch.tv/
- document: HTTP 200, text/html; charset=utf-8, 215842 bytes, 1 redirect hop(s)
- mirrored at: `http://127.0.0.1:5221/proxy/https/www.twitch.tv/`

## Netflix — ok

- target: https://www.netflix.com/
- document: HTTP 200, text/html; charset=utf-8, 671866 bytes, 1 redirect hop(s)
- mirrored at: `http://127.0.0.1:5221/proxy/https/www.netflix.com/`

## Disney+ — ok

- target: https://www.disneyplus.com/
- document: HTTP 200, text/html; charset=utf-8, 1932321 bytes, 1 redirect hop(s)
- mirrored at: `http://127.0.0.1:5221/proxy/https/www.disneyplus.com/`

## Spotify — ok

- target: https://open.spotify.com/
- document: HTTP 200, text/html; charset=utf-8, 178116 bytes, 1 redirect hop(s)
- mirrored at: `http://127.0.0.1:5221/proxy/https/open.spotify.com/`

## Apple Music — ok

- target: https://music.apple.com/
- document: HTTP 200, text/html; charset=utf-8, 2421998 bytes, 2 redirect hop(s)
- mirrored at: `http://127.0.0.1:5221/proxy/https/music.apple.com/us/new`

## SoundCloud — ok

- target: https://soundcloud.com/
- document: HTTP 200, text/html; charset=utf-8, 81753 bytes, 1 redirect hop(s)
- mirrored at: `http://127.0.0.1:5221/proxy/https/soundcloud.com/`

## Discord — challenge

- target: https://discord.com/app
- document: HTTP 200, text/html; charset=utf-8, 105952 bytes, 1 redirect hop(s)
- mirrored at: `http://127.0.0.1:5221/proxy/https/discord.com/app`
- note: Cloudflare challenge - a real browser may still clear this, since the challenge is solved by JavaScript that only the browser runs

## Reddit — ok

- target: https://www.reddit.com/
- document: HTTP 200, text/html; charset=utf-8, 21129 bytes, 1 redirect hop(s)
- mirrored at: `http://127.0.0.1:5221/proxy/https/www.reddit.com/`

## X — ok

- target: https://x.com/
- document: HTTP 200, text/html; charset=utf-8, 48756 bytes, 1 redirect hop(s)
- mirrored at: `http://127.0.0.1:5221/proxy/https/x.com/`

## Instagram — ok

- target: https://www.instagram.com/
- document: HTTP 200, text/html; charset=utf-8, 644513 bytes, 1 redirect hop(s)
- mirrored at: `http://127.0.0.1:5221/proxy/https/www.instagram.com/`

## TikTok — ok

- target: https://www.tiktok.com/
- document: HTTP 200, text/html; charset=utf-8, 383986 bytes, 1 redirect hop(s)
- mirrored at: `http://127.0.0.1:5221/proxy/https/www.tiktok.com/`

## Pinterest — ok

- target: https://www.pinterest.com/
- document: HTTP 200, text/html; charset=utf-8, 1242340 bytes, 1 redirect hop(s)
- mirrored at: `http://127.0.0.1:5221/proxy/https/www.pinterest.com/`

## GitHub — ok

- target: https://github.com/
- document: HTTP 200, text/html; charset=utf-8, 592471 bytes, 1 redirect hop(s)
- mirrored at: `http://127.0.0.1:5221/proxy/https/github.com/`

## Roblox — ok

- target: https://www.roblox.com/
- document: HTTP 200, text/html; charset=utf-8, 104059 bytes, 1 redirect hop(s)
- mirrored at: `http://127.0.0.1:5221/proxy/https/www.roblox.com/`

## Google — ok

- target: https://www.google.com/
- document: HTTP 200, text/html; charset=utf-8, 236213 bytes, 1 redirect hop(s)
- mirrored at: `http://127.0.0.1:5221/proxy/https/www.google.com/`

## DuckDuckGo — ok

- target: https://duckduckgo.com/
- document: HTTP 200, text/html; charset=utf-8, 360491 bytes, 1 redirect hop(s)
- mirrored at: `http://127.0.0.1:5221/proxy/https/duckduckgo.com/`

## ChatGPT — ok

- target: https://chatgpt.com/
- document: HTTP 200, text/html; charset=utf-8, 324651 bytes, 1 redirect hop(s)
- mirrored at: `http://127.0.0.1:5221/proxy/https/chatgpt.com/`

## Duck.ai — ok

- target: https://duck.ai/
- document: HTTP 200, text/html; charset=utf-8, 40233 bytes, 1 redirect hop(s)
- mirrored at: `http://127.0.0.1:5221/proxy/https/duck.ai/`

## Claude — challenge

- target: https://claude.ai/
- document: HTTP 200, text/html; charset=utf-8, 150452 bytes, 2 redirect hop(s)
- mirrored at: `http://127.0.0.1:5221/proxy/https/claude.ai/login`
- note: Cloudflare challenge - a real browser may still clear this, since the challenge is solved by JavaScript that only the browser runs

## Wikipedia — ok

- target: https://www.wikipedia.org/
- document: HTTP 200, text/html; charset=utf-8, 111093 bytes, 1 redirect hop(s)
- mirrored at: `http://127.0.0.1:5221/proxy/https/www.wikipedia.org/`

## Steam — ok

- target: https://store.steampowered.com/
- document: HTTP 200, text/html; charset=utf-8, 1268076 bytes, 1 redirect hop(s)
- mirrored at: `http://127.0.0.1:5221/proxy/https/store.steampowered.com/`

## GeForce NOW — ok

- target: https://play.geforcenow.com/
- document: HTTP 200, text/html; charset=utf-8, 83686 bytes, 2 redirect hop(s)
- mirrored at: `http://127.0.0.1:5221/proxy/https/play.geforcenow.com/mall/`

