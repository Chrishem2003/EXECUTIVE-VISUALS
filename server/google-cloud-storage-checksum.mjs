import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

const CRC32C_TABLE=(()=>{
 const table=new Uint32Array(256);
 for(let n=0;n<256;n++){
  let value=n;
  for(let bit=0;bit<8;bit++)value=(value&1)?(value>>>1)^0x82f63b78:value>>>1;
  table[n]=value>>>0;
 }
 return table;
})();

export function crc32cBase64(input){
 const bytes=Buffer.isBuffer(input)?input:Buffer.from(input);
 let crc=0xffffffff;
 for(const byte of bytes)crc=CRC32C_TABLE[(crc^byte)&0xff]^(crc>>>8);
 const result=Buffer.allocUnsafe(4);
 result.writeUInt32BE((~crc)>>>0,0);
 return result.toString("base64");
}

export async function computeFileChecksums(filePath){
 const sha256=createHash("sha256");
 let crc=0xffffffff;
 for await(const chunk of createReadStream(filePath)){
  sha256.update(chunk);
  for(const byte of chunk)crc=CRC32C_TABLE[(crc^byte)&0xff]^(crc>>>8);
 }
 const checksum=Buffer.allocUnsafe(4);
 checksum.writeUInt32BE((~crc)>>>0,0);
 return Object.freeze({sha256:sha256.digest("hex"),crc32c:checksum.toString("base64")});
}

export function validCrc32c(value){
 return typeof value==="string"&&/^[A-Za-z0-9+/]{6}==$/.test(value);
}
