import sys
import re
with open('js/app.js', 'r', encoding='utf-8') as f:
    content = f.read()

content, count = re.subn(r'sotto\.slice\(0,\s*8\)', r'sotto', content)

if count > 0:
    with open('js/app.js', 'w', encoding='utf-8') as f:
        f.write(content)
    print('SUCCESS')
else:
    print('TARGET NOT FOUND')
