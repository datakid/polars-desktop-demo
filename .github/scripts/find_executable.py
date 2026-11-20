import json
import sys

found = None
for line in open(sys.argv[1]):
    try:
        message = json.loads(line)
    except ValueError:
        continue
    if message.get("executable") and message.get("target", {}).get("name") == sys.argv[2]:
        found = message["executable"]
print(found or "")
