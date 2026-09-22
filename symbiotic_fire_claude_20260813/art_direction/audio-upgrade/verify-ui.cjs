const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_EXE,headless:true,args:['--autoplay-policy=no-user-gesture-required']});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 const base=process.argv[2]||'http://127.0.0.1:8765';await page.goto(base+'/_audio-art.html');
 await page.getByRole('button',{name:'启用声音',exact:true}).click();await page.waitForFunction(()=>SOUND.stats.loads===38,null,{polling:50});
 assert.equal(await page.locator('.card').count(),38);
 await page.getByRole('button',{name:'播放',exact:true}).first().click();assert.equal(await page.evaluate(()=>SOUND.picks.rifle),0);
 await page.getByRole('button',{name:'停止',exact:true}).click();assert.equal(await page.evaluate(()=>SOUND.voices.size),0);
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.goto(base+'/?seed=12345');await page.evaluate(()=>{Audio2.init();G.paused=true;document.getElementById('menu').classList.remove('on');document.getElementById('pause').classList.add('on');});
 await page.setViewportSize({width:1440,height:1000});
 await page.goto(base+'/_todo13check.html');await page.waitForFunction(()=>/ALLPASS|FAILED \d/.test(document.body.innerText),null,{timeout:30000});
 assert.ok((await page.locator('body').innerText()).includes('ALLPASS'));assert.deepEqual(errors,[]);
 const result={pass:true,checks:['38 sound cards','final asset playback buttons','stop button','390px layout','pause mixer displayed','TODO13 ALLPASS'],errors};
 fs.writeFileSync(path.join(__dirname,'ui-check.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
