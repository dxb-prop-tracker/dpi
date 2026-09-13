"""Round-trip an xlsx part through Python's XML writer without Excel rejecting the result.

Two things go wrong if you simply ET.fromstring / ET.tostring an Office part, and neither shows up
in any validator short of Excel itself:

1. THE DEFAULT NAMESPACE GETS A PREFIX. SpreadsheetML declares its main namespace with no prefix -
   xmlns="...spreadsheetml/2006/main" - so tags are written <worksheet>, <row>, <c>. ElementTree
   writes whatever prefix is registered for that URI, and if none is, it invents ns0. The file is
   still well-formed and LibreOffice opens it happily; Excel refuses it.

2. PREFIXED NAMESPACES GET RENAMED. r:, mc:, xdr:, x14ac:, xr: and the rest become ns1, ns2, ns3 -
   and mc:Ignorable="x14ac xr xr2 xr3" then names prefixes that are no longer declared anywhere.

ElementTree's prefix registry is global and last-write-wins, so registering from one part can break
the next: parts disagree about which prefix a URI takes, and xl/comments.xml in particular declares
the main SpreadsheetML namespace with a prefix, which is enough to prefix every tag in every sheet
written afterwards.

So the mapping is captured per part when it is parsed, and re-applied immediately before that part
is written. Nothing is assumed and nothing is shared between parts.
"""
import re
import xml.etree.ElementTree as ET

_PREFIXED = re.compile(rb'xmlns:([A-Za-z_][\w.\-]*)\s*=\s*"([^"]+)"')
_DEFAULT = re.compile(rb'<[A-Za-z_][\w.\-]*\s[^>]*?xmlns\s*=\s*"([^"]+)"')
DECLARATION = b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

_decls = {}          # id(root) -> (default_uri | None, {prefix: uri}, original root start-tag)
_ROOT_TAG = re.compile(rb'<([A-Za-z_][\w.\-]*)(\s[^>]*?)?/?>')


def _apply(default_uri, prefixed):
    """Make ElementTree's global prefix registry match this part, exactly."""
    for prefix, uri in prefixed.items():
        try:
            ET.register_namespace(prefix, uri)
        except ValueError:
            pass
    if default_uri:                      # registered LAST so it wins for its URI
        try:
            ET.register_namespace('', default_uri)
        except ValueError:
            pass


def parse(raw: bytes):
    """Parse a part, remembering the prefixes it declared so they survive the write."""
    dm = _DEFAULT.search(raw)
    default_uri = dm.group(1).decode('utf-8') if dm else None
    prefixed = {p.decode('utf-8'): u.decode('utf-8') for p, u in _PREFIXED.findall(raw)}
    root = ET.fromstring(raw)
    m = _ROOT_TAG.search(raw[raw.index(b'<', raw.index(b'?>') + 2 if b'?>' in raw[:200] else 0):])
    _decls[id(root)] = (default_uri, prefixed, m.group(0) if m else b'')
    return root


def tostring(root) -> bytes:
    """Serialise a part with the prefixes it was parsed with, and Excel's own declaration.

    The last step is the one that is easy to miss. ElementTree declares a namespace only if some
    element or attribute in the tree actually uses it — but a sheet root also carries
    mc:Ignorable="x14ac xr xr2 xr3", which NAMES prefixes without using them. Those declarations are
    dropped, mc:Ignorable is left pointing at prefixes that no longer exist, and Excel refuses the
    file. So any declaration present on the original root and missing from the new one is put back.
    """
    default_uri, prefixed, orig_root = _decls.get(id(root), (None, {}, b''))
    _apply(default_uri, prefixed)
    out = ET.tostring(root, encoding='utf-8', xml_declaration=False)
    if orig_root:
        m = _ROOT_TAG.search(out)
        if m:
            new_tag = m.group(0)
            have = set(re.findall(rb'xmlns:([\w.\-]+)=', new_tag))
            missing = [f' xmlns:{p.decode()}="{u.decode()}"'.encode()
                       for p, u in _PREFIXED.findall(orig_root) if p not in have]
            if missing:
                close = b'/>' if new_tag.endswith(b'/>') else b'>'
                patched = new_tag[:-len(close)] + b''.join(missing) + close
                out = out[:m.start()] + patched + out[m.end():]
    return DECLARATION + out
