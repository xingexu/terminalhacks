import json, copy
from pathlib import Path
from jsonschema import Draft202012Validator, FormatChecker
P=Path(__file__).parent
def load(n): return json.loads((P/n).read_text())
def validator(n):
 s=load(n); Draft202012Validator.check_schema(s); return Draft202012Validator(s,format_checker=FormatChecker())
v=validator('command-envelope.schema.json'); f=validator('core-projection.schema.json'); f.validate(load('fixture.json')); n=1
for cmd in load('command-examples.json'):
 v.validate(cmd); n+=1
 for mutation in ['extra','missing','unknown']:
  bad=copy.deepcopy(cmd)
  if mutation=='extra': bad['payload']['unexpected']=True
  elif mutation=='missing': del bad['previewToken']
  else: bad['type']='not.a.command'
  assert not v.is_valid(bad),bad
  n+=1
for tool in load('mcp-tools.json')['tools']:
 Draft202012Validator.check_schema(tool['inputSchema']); n+=1
print(f'{n} schema/fixture checks passed (not production integration tests)')
