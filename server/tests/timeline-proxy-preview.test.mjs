import test from "node:test";
import assert from "node:assert/strict";
import { buildProxyVideoArgs, buildMediaProcessingProvenance } from "../media.mjs";

test("timeline proxy uses a bounded 960p H.264/AAC profile with fast-start metadata",()=>{
 const args=buildProxyVideoArgs({sourcePath:"/media/source.mp4",outputPath:"/media/proxy.mp4",input:{}});
 assert.deepEqual(args,["-hide_banner","-y","-i","/media/source.mp4","-vf","scale='min(960,iw)':-2","-c:v","libx264","-preset","veryfast","-crf","28","-maxrate","2M","-bufsize","4M","-c:a","aac","-b:a","128k","-movflags","+faststart","/media/proxy.mp4"]);
});

test("timeline proxy clamps dimensions and quality values before building FFmpeg arguments",()=>{
 const args=buildProxyVideoArgs({sourcePath:"source.mov",outputPath:"proxy.mp4",input:{proxyWidth:9000,proxyCrf:-10}});
 assert.ok(args.some(value=>value.includes("1920")));
 assert.ok(args.includes("18"));
 assert.equal(args.some(value=>value.includes("drawtext")||value.includes(";")),false);
});

test("proxy provenance records profile and source lineage",()=>{
 const result=buildMediaProcessingProvenance({jobType:"media.proxy",input:{proxyWidth:960,proxyCrf:28,proxyProfile:"timeline-preview-960p"},sourceAsset:{id:"source-1",sha256:"abc"}});
 assert.equal(result.method,"editing-proxy-transcode");
 assert.equal(result.sourceAssetId,"source-1");
 assert.deepEqual(result.parameters,{proxyWidth:960,proxyCrf:28,proxyProfile:"timeline-preview-960p"});
 assert.equal(result.aiInferencePerformed,false);
});
