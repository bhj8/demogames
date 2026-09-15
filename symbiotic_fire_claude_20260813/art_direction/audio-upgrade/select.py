"""Select checked original WAVs; preserve source bytes and record playback metadata."""
import csv, hashlib, json, re, shutil
from pathlib import Path
import numpy as np
import soundfile as sf

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
report=json.loads((HERE/'source-check.json').read_text(encoding='utf-8'))
rows=list(csv.DictReader((HERE/'source/manifest.csv').open(encoding='utf-8-sig')))
by_name={r['name']:r for r in rows}
groups={}
audit=[]
for entry in report['files']:
    path=ROOT/entry['path']; row=by_name[path.stem]
    data,sr=sf.read(path,dtype='float32',always_2d=True)
    mono=data.mean(axis=1); block=int(sr*.005)
    rms=np.sqrt(np.mean(mono[:len(mono)//block*block].reshape(-1,block)**2,axis=1)+1e-12)
    active=np.flatnonzero(rms>max(.003,float(rms.max())*.035))
    onset=max(0,float(active[0])*block/sr-.008) if len(active) else 999
    end=min(len(mono)/sr,float(active[-1]+1)*block/sr+.035) if len(active) else 0
    expected=max(1,round(float(row['duration']))) # AIGA runner rounds seconds before inference.
    errors=[]
    if entry['status']!='pass':errors.append('AIGA hard gate')
    if abs(len(mono)/sr-expected)>.15:errors.append('duration mismatch')
    if not np.isfinite(data).all():errors.append('non-finite sample')
    if np.sqrt(np.mean(mono[-int(sr*.005):]**2))>.03:errors.append('unfinished loud tail')
    kind=re.sub(r'_v\d+$','',re.sub(r'_\d+$','',path.stem))
    if onset>.12 and kind!='city_air':errors.append('late onset')
    item={'file':path.name,'kind':kind,'source':str(path),'seed':int(row['seed']),
          'duration':len(mono)/sr,'effectiveRequestedDuration':expected,'onset':round(onset,5),
          'end':round(end,5),'gain':round(float(np.clip(.2/max(.01,np.percentile(rms,95)),.18,.85)),5),
          'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'errors':errors,
          'score':round(onset*4+entry['metrics']['clippingRatio']*100+max(0,.1-end),5)}
    audit.append(item)
    if not errors:groups.setdefault(kind,[]).append(item)
expected_kinds={re.sub(r'_v\d+$','',re.sub(r'_\d+$','',r['name'])) for r in rows}
missing=sorted(k for k in expected_kinds if len(groups.get(k,[]))<2)
if missing:
    (HERE/'selection-analysis.json').write_text(json.dumps({'candidates':audit,'missing':missing},indent=2),encoding='utf-8')
    raise SystemExit('Need more passing seeds: '+', '.join(missing))
dest=ROOT/'assets/audio';dest.mkdir(parents=True,exist_ok=True)
bank={'version':1,'generator':'Stable Audio 3 small-sfx','sounds':{}}
selected=[]
for kind in sorted(groups):
    picks=sorted(groups[kind],key=lambda x:x['score'])[:2]
    bank['sounds'][kind]=[]
    for p in picks:
        shutil.copyfile(p['source'],dest/p['file'])
        bank['sounds'][kind].append({k:p[k] for k in ['file','duration','onset','end','gain']})
        selected.append({k:v for k,v in p.items() if k!='source'})
(dest/'bank.json').write_text(json.dumps(bank,indent=2)+'\n',encoding='utf-8')
for p in audit:p.pop('source',None)
(HERE/'selection.json').write_text(json.dumps({'selected':selected,'candidates':audit,'subjectiveListening':'not evaluated'},indent=2)+'\n',encoding='utf-8')
shutil.copyfile(HERE/'source/manifest.csv',HERE/'generation-manifest.csv')
print(json.dumps({'kinds':len(bank['sounds']),'selected':len(selected),'rejected':[p['file'] for p in audit if p['errors']],
                  'bytes':sum((dest/p['file']).stat().st_size for p in selected)},indent=2))
