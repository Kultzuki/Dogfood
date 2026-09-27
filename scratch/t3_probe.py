"""Live T3 probe: voting window -> vote -> duplicate -> hidden counts ->
comment -> ballot page. Uses fixture cookies + CSRF from the logout form."""
import json
import re
import urllib.request

BASE = "http://localhost:3000"
ORG = "sid=fixture-organizer.EfyaJgl4j1Y0WFn48SotVsOy0Tr24wJW2oDtWOHaRsQ"
PART = "sid=fixture-participant.H0ZKo-8BO3h5P-1xKV8RSm7IyH2GXYklOP4ZlcsrGX4"
EVENT = "8a96dfb6-4af2-4c48-afb3-98bcf494ce84"


def req(method, path, sid=None, body=None, csrf=None):
    r = urllib.request.Request(BASE + path, method=method)
    if sid:
        r.add_header("Cookie", sid)
    if csrf:
        r.add_header("x-csrf-token", csrf)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, data=data, timeout=10) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def csrf_for(sid):
    _, html = req("GET", "/gallery", sid=sid)
    m = re.search(r'name="_csrf" value="([^"]+)"', html)
    assert m, "no csrf token rendered"
    return m.group(1)


print("== T3 live probe ==")
oc, pc = csrf_for(ORG), csrf_for(PART)

# 1. open a voting window (organizer)
s, b = req("POST", f"/api/events/{EVENT}/voting-window", sid=ORG,
           body={"opens_at": "2020-01-01T00:00:00.000Z", "closes_at": None}, csrf=oc)
print("window open:", s, b[:160])
assert s == 200 and '"active":true' in b

# 2. pick a submitted project from the gallery
s, html = req("GET", "/gallery", sid=PART)
m = re.search(r'/gallery/([0-9a-f-]{36})', html)
assert s == 200 and m, "no project link"
pid = m.group(1)
print("project:", pid)

# 3. vote outside window? (window IS open) -> 201
s, b = req("POST", f"/api/projects/{pid}/vote", sid=PART, body={}, csrf=pc)
print("vote:", s, b[:160])
assert s == 201

# 4. duplicate -> 409
s, b = req("POST", f"/api/projects/{pid}/vote", sid=PART, body={}, csrf=pc)
print("duplicate:", s, b[:80])
assert s == 409

# 5. counts hidden from participant while active -> 404; visible to organizer
s, _ = req("GET", f"/api/projects/{pid}/votes", sid=PART)
print("counts participant (active):", s)
assert s == 404
s, b = req("GET", f"/api/projects/{pid}/votes", sid=ORG)
print("counts organizer (active):", s, b[:80])
assert s == 200 and '"votes":1' in b

# 6. ballot page renders, stable across refreshes
s, h1 = req("GET", f"/events/{EVENT}/ballot", sid=PART)
s2, h2 = req("GET", f"/events/{EVENT}/ballot", sid=PART)
print("ballot:", s, "stable:", h1 == h2, "has vote btn:", "Vote for this project" in h1)
assert s == 200 and h1 == h2 and "Vote for this project" in h1

# 7. comment create + list
s, b = req("POST", f"/api/projects/{pid}/comments", sid=PART,
           body={"body": "Live probe comment <b>escaped</b>"}, csrf=pc)
print("comment post:", s, b[:120])
assert s == 201
s, b = req("GET", f"/api/projects/{pid}/comments")
print("comment list:", s, b[:160])
assert s == 200 and "Live probe comment" in b
s, html = req("GET", f"/gallery/{pid}", sid=PART)
assert "Live probe comment" in html and "&lt;b&gt;escaped&lt;/b&gt;" in html
print("detail renders comment escaped: True")

# 8. close the window -> counts go public, voting refused
s, b = req("POST", f"/api/events/{EVENT}/voting-window", sid=ORG,
           body={"opens_at": "2020-01-01T00:00:00.000Z",
                 "closes_at": "2020-02-01T00:00:00.000Z"}, csrf=oc)
assert s == 200 and '"active":false' in b
s, b = req("GET", f"/api/projects/{pid}/votes")
print("counts public (closed):", s, b[:80])
assert s == 200 and '"votes":1' in b
s, b = req("POST", f"/api/projects/{pid}/vote", sid=PART, body={}, csrf=pc)
print("vote after close:", s, b[:80])
assert s == 422

print("T3 LIVE PROBE: ALL OK")
