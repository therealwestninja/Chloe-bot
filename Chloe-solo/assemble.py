#!/usr/bin/env python3
# Assemble the self-contained Chloe Solo app: inline engine.js, the reused brain handlers, and the
# AICC character importer into solo.html's three markers. Byte-exact injection (no reformatting).
import io, sys, os
HERE = os.path.dirname(os.path.abspath(__file__))
def read(p): return io.open(os.path.join(HERE, p), encoding='utf-8').read()

html = read('solo.html')
parts = {
    '/*__ENGINE__*/':     read('engine.js'),
    '/*__BRAIN__*/':      read('brain-block.js'),
    '/*__CHARIMPORT__*/': read('charimport-block.js'),
}
for marker, code in parts.items():
    if marker not in html:
        sys.exit('FAIL: marker %s not found in solo.html' % marker)
    if html.count(marker) != 1:
        sys.exit('FAIL: marker %s appears %d times (want 1)' % (marker, html.count(marker)))
    html = html.replace(marker, code)

out = os.path.join(HERE, 'solo-app.html')
io.open(out, 'w', encoding='utf-8').write(html)
print('ok solo-app.html (%d bytes)' % len(html.encode('utf-8')))
