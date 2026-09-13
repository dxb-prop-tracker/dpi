#!/usr/bin/env python3
"""Build the three known-bad workbooks from the canonical one, so the acceptance test can be proven
to catch each of them on every CI run. Each corresponds to a real failure Excel produced."""
import os, re, zipfile
import xml.etree.ElementTree as ET
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'canonical.xlsx')

def make(out, mutate):
    with zipfile.ZipFile(SRC) as s, zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as d:
        for it in s.infolist():
            b = mutate(it.filename, s.read(it.filename))
            if b is not None:
                d.writestr(it, b)

def bad_ignorable(n, b):          # a naive ET round-trip drops the prefixes mc:Ignorable names
    if n == 'xl/worksheets/sheet9.xml':
        ET.register_namespace('', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
        for p, u in re.findall(rb'xmlns:([\w.\-]+)="([^"]+)"', b):
            ET.register_namespace(p.decode(), u.decode())
        return ET.tostring(ET.fromstring(b), encoding='utf-8', xml_declaration=True)
    return b

def bad_comment(n, b):            # a comment anchored to a row that no longer exists
    return b.replace(b'ref="F39"', b'ref="F999"', 1) if n == 'xl/comments3.xml' else b

def bad_calcchain(n, b):          # the chain removed, its references left behind
    return None if n == 'xl/calcChain.xml' else b

make(os.path.join(HERE, 'bad_ignorable.xlsx'), bad_ignorable)
make(os.path.join(HERE, 'bad_comment.xlsx'), bad_comment)
make(os.path.join(HERE, 'bad_calcchain.xlsx'), bad_calcchain)
print('fixtures built')
