export interface CaptionPreset {
 id:string;
 label:string;
 description:string;
 fontName:string;
 fontSize:number;
 primaryColor:string;
 alignment:number;
 backgroundMode:"box"|"none";
 backgroundColor:string;
 backgroundOpacity:number;
 outline:number;
 shadow:number;
 marginV:number;
}
export const CAPTION_PRESETS:readonly CaptionPreset[]=[
 {id:"social-bold",label:"Social high-contrast",description:"Large, high-contrast captions for vertical and short-form viewing.",fontName:"DejaVu Sans",fontSize:46,primaryColor:"#FFFFFF",alignment:2,backgroundMode:"box",backgroundColor:"#000000",backgroundOpacity:0.86,outline:2,shadow:1,marginV:72},
 {id:"cinematic",label:"Cinematic",description:"Restrained, centered subtitles with a subtle dark outline.",fontName:"DejaVu Sans",fontSize:34,primaryColor:"#F4F0E8",alignment:2,backgroundMode:"none",backgroundColor:"#000000",backgroundOpacity:0.68,outline:2,shadow:1,marginV:54},
 {id:"broadcast",label:"Broadcast safe",description:"Readable lower-third captions with a strong backing panel.",fontName:"DejaVu Sans",fontSize:32,primaryColor:"#FFFFFF",alignment:2,backgroundMode:"box",backgroundColor:"#000000",backgroundOpacity:0.92,outline:1,shadow:0,marginV:48},
 {id:"minimal",label:"Minimal",description:"Smaller, clean captions without a background panel.",fontName:"DejaVu Sans",fontSize:29,primaryColor:"#FFFFFF",alignment:2,backgroundMode:"none",backgroundColor:"#000000",backgroundOpacity:0.68,outline:1,shadow:1,marginV:42},
 {id:"top-caption",label:"Top placement",description:"High-positioned captions for footage with busy lower frames.",fontName:"DejaVu Sans",fontSize:36,primaryColor:"#FFFFFF",alignment:8,backgroundMode:"box",backgroundColor:"#000000",backgroundOpacity:0.78,outline:1,shadow:1,marginV:54}
];
export function getCaptionPreset(id:string):CaptionPreset|undefined{return CAPTION_PRESETS.find(preset=>preset.id===id);}
export function applyCaptionPreset(id:string,current:Record<string,unknown>={}):Record<string,unknown>{
 const preset=getCaptionPreset(id);
 if(!preset)throw new Error("Unknown caption preset.");
 const {id:presetId,label:_label,description:_description,...style}=preset;
 return {...current,...style,presetId};
}
