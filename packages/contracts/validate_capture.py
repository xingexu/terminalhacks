from pathlib import Path
import json,copy
from jsonschema import Draft202012Validator,FormatChecker
p=Path(__file__).parent
s=json.loads((p/'capture-observation.schema.json').read_text()); Draft202012Validator.check_schema(s)
v=Draft202012Validator(s,format_checker=FormatChecker()); examples=json.loads((p/'capture-examples.json').read_text()); n=0
for x in examples:
 v.validate(x); n+=1
 for field in s['required']:
  y=copy.deepcopy(x);del y[field];assert not v.is_valid(y);n+=1
 for key,value in [('actorId','other'),('status','approved'),('source','unknown'),('capturedAt','yesterday'),('location',{'lat':91,'lon':0,'accuracyM':0,'precision':'coarse'})]:
  y=copy.deepcopy(x);y[key]=value;assert not v.is_valid(y);n+=1
 y=copy.deepcopy(x);y['text' if x['kind']=='media' else 'mediaId']='extra';assert not v.is_valid(y);n+=1
 y=copy.deepcopy(x);del y['mediaId' if x['kind']=='media' else 'text'];assert not v.is_valid(y);n+=1
print(f'{n} capture schema checks passed (syntax only)')
