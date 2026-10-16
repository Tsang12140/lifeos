export class Editor {
 constructor(options: {editor: HTMLElement; onUpdate?:()=>void; onToast?:(text:string)=>void; onPrompt?:(...args:any[])=>any; onImageSelect?:(image:HTMLElement|null)=>void; onDataImageInserted?:()=>void});
 editor: HTMLElement; selectedImage: HTMLElement|null;
 getHTML():string; setHTML(html:string):void; toMarkdown():string; toPlainText():string; buildSelfContainedHTML():string;
 exec(command:string,value?:string):void; formatBlock(tag:string):void; insertQuote():void; insertCodeBlock():void; insertInlineCode():void; insertTable(rows?:number,cols?:number):void; insertLink():void; insertImage(url:string,range?:Range):void;
 undo():void; redo():void; focus():void; destroy():void; fixImageContainers():void; normalizeTables():void;
 alignImage(image:HTMLElement,align:string):void; fitImageWidth(image:HTMLElement):void; smallImageSize(image:HTMLElement):void; deleteImage(image:HTMLElement):void;
 }
