export type CaptionStylePreset={
 id:string;label:string;fontName:string;fontSize:number;primaryColor:string;alignment:number;
 backgroundMode:"box"|"none";backgroundColor:string;backgroundOpacity:number;
 outline:number;shadow:number;marginV:number;
};
const PRESETS:CaptionStylePreset[]=[
 {id:"standard",label:"Standard clean",fontName:"DejaVu Sans",fontSize:32,primaryColor:"#FFFFFF",alignment:2,backgroundMode:"box",backgroundColor:"#000000",backgroundOpacity:0.68,outline:2,shadow:1,marginV:42},
 {id:"social-bold",label:"Social bold",fontName:"DejaVu Sans",fontSize:48,primaryColor:"#FFFFFF",alignment:2,backgroundMode:"box",backgroundColor:"#000000",backgroundOpacity:0.82,outline:3,shadow:2,marginV:84},
 {id:"documentary",label:"Documentary",fontName:"DejaVu Sans",fontSize:30,primaryColor:"#FFF4DC",alignment:2,backgroundMode:"box",backgroundColor:"#101010",backgroundOpacity:0.58,outline:1,shadow:1,marginV:54},
 {id:"headline-top",label:"Top headline",fontName:"DejaVu Sans",fontSize:38,primaryColor:"#FFFFFF",alignment:8,backgroundMode:"none",backgroundColor:"#000000",backgroundOpacity:0,outline:3,shadow:2,marginV:60}
];
export function listCaptionStylePresets():CaptionStylePreset[]{return PRESETS.map(preset=>({...preset}));}
export function getCaptionStylePreset(id:string):CaptionStylePreset{
 const preset=PRESETS.find(item=>item.id===String(id));
 if(!preset)throw new Error("Unknown caption style preset.");
 return {...preset};
}
