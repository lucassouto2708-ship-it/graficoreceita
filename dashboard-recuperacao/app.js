(function(){
const C = window.CONFIG;
const brl = n => n.toLocaleString("pt-BR",{style:"currency",currency:"BRL"});
const $ = id => document.getElementById(id);
const norm = s => (s||"").toString().normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase().replace(/\s+/g," ").trim();

// CSV -> matriz
function parseCSV(t){
  const rows=[];let r=[],f="",q=false;
  for(let i=0;i<t.length;i++){
    const c=t[i];
    if(q){ if(c=='"'){ if(t[i+1]=='"'){f+='"';i++;} else q=false; } else f+=c; }
    else if(c=='"') q=true;
    else if(c==","){ r.push(f);f=""; }
    else if(c=="\n"||c=="\r"){ if(c=="\r"&&t[i+1]=="\n")i++; r.push(f);rows.push(r);r=[];f=""; }
    else f+=c;
  }
  if(f!==""||r.length){r.push(f);rows.push(r);}
  return rows;
}
// "R$ 1.234,56" -> 1234.56
function money(s){
  if(s==null) return 0;
  let x=String(s).replace(/[^\d,.-]/g,"");
  if(!x) return 0;
  if(x.includes(",")) x=x.replace(/\./g,"").replace(",",".");
  else if((x.match(/\./g)||[]).length>1) x=x.replace(/\./g,"");
  const n=parseFloat(x); return isNaN(n)?0:n;
}
function isPago(s){
  const n=norm(s); if(!n) return false;
  if(C.PALAVRAS_NAO_PAGO.some(p=>n.includes(norm(p)))) return false;
  return C.PALAVRAS_PAGO.some(p=>n.includes(norm(p)));
}
// extrai data dd/mm[/aaaa] de um texto; retorna "aaaa-mm-dd" ou null
function dataDe(s){
  const m=String(s||"").match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if(!m) return null;
  let y=m[3]?+m[3]:new Date().getFullYear(); if(y<100) y+=2000;
  const d=+m[1],mo=+m[2]; if(d<1||d>31||mo<1||mo>12) return null;
  return `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
}
// acha a linha de cabeçalho (a que contém "Nome do Contribuinte") e devolve objetos por coluna
function tabela(rows){
  let h=rows.findIndex(r=>r.some(c=>norm(c).startsWith("nome do contribuinte")));
  if(h<0) return {head:[],data:[]};
  const head=rows[h].map(norm);
  const data=rows.slice(h+1).filter(r=>r.some(c=>(c||"").trim()) && (r[0]||"").trim());
  return {head,data};
}
const col=(head,...nomes)=>{ for(const n of nomes){ const i=head.findIndex(x=>x.startsWith(norm(n))); if(i>=0) return i; } return -1; };
const colsTodas=(head,prefixo)=>head.map((x,i)=>x.startsWith(norm(prefixo))?i:-1).filter(i=>i>=0);

async function baixa(nome){
  const url=`https://docs.google.com/spreadsheets/d/${C.SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(nome)}&_=${Date.now()}`;
  const r=await fetch(url); if(!r.ok) throw new Error("HTTP "+r.status);
  return parseCSV(await r.text());
}

let gTent,gRec;
async function carregar(){
  const msg=$("msg"); msg.style.display="none";
  if(C.SHEET_ID.startsWith("COLE")){ msg.textContent="Falta configurar o ID da planilha no arquivo config.js."; msg.style.display="block"; $("upd").textContent="Sem planilha configurada"; return; }
  $("upd").textContent="Atualizando…";
  const dias={}; let totalG=0,linhasC=0,tent=0,tentSemData=0,rec=0,recN=0,abertoC=0;
  let pPago=0,pAber=0,pN=0,pNPagos=0,pTotalDA=0;
  const erros=[];
  for(const aba of C.ABAS){
    let rows; try{ rows=await baixa(aba.nome); }catch(e){ erros.push(aba.nome); continue; }
    const {head,data}=tabela(rows);
    if(!head.length){ erros.push(aba.nome+" (cabeçalho não encontrado)"); continue; }
    const iSit=col(head,"situacao");
    if(aba.tipo==="cobranca"){
      const iVal=col(head,"valor atual");
      const iTent=colsTodas(head,"tentativa");
      data.forEach(r=>{
        linhasC++;
        const v=money(r[iVal]); totalG+=v;
        if(isPago(r[iSit])){ rec+=v; recN++; } else abertoC+=v;
        iTent.forEach(i=>{
          const cel=(r[i]||"").trim(); if(!cel) return;
          tent++; const d=dataDe(cel);
          if(d) dias[d]=(dias[d]||0)+1; else tentSemData++;
        });
      });
    } else {
      const iPar=col(head,"valor da parcela"), iQ=col(head,"qtde de parcelas","qtd"), iDA=col(head,"valor total");
      data.forEach(r=>{
        const vp=money(r[iPar]), q=Math.round(money(r[iQ]))||0, tot=vp*q; pN++;
        pTotalDA+=money(r[iDA]);
        if(isPago(r[iSit])){ pPago+=tot; pNPagos++; } else pAber+=tot;
      });
    }
  }
  if(erros.length){ msg.textContent="Não consegui ler: "+erros.join(", ")+". Confira o nome da aba em config.js e se a planilha está compartilhada como 'qualquer pessoa com o link'."; msg.style.display="block"; }

  $("kTotal").textContent=brl(totalG); $("kTotalS").textContent=linhasC+" contribuintes na cobrança";
  $("kTent").textContent=tent; $("kTentS").textContent=tentSemData?tentSemData+" sem data legível":"";
  $("kRec").textContent=brl(rec); $("kRecS").textContent=recN+" pagos"+(totalG?" · "+(rec/totalG*100).toFixed(1)+"% do total":"");
  $("kAReceber").textContent=brl(pAber); $("kARecS").textContent="parcelas ainda não pagas";
  $("pPago").textContent=brl(pPago); $("pAber").textContent=brl(pAber);
  const pt=pPago+pAber; $("pBar").style.width=(pt?pPago/pt*100:0)+"%";
  $("pInfo").textContent=pN+" parcelamentos ("+pNPagos+" quitados)";
  $("upd").textContent="Atualizado às "+new Date().toLocaleTimeString("pt-BR");

  const ks=Object.keys(dias).sort();
  // preenche dias sem tentativas com 0
  const lab=[],val=[];
  if(ks.length){ for(let d=new Date(ks[0]+"T00:00");d<=new Date(ks[ks.length-1]+"T00:00");d.setDate(d.getDate()+1)){
    const k=d.toISOString().slice(0,10); lab.push(k.split("-").reverse().slice(0,2).join("/")); val.push(dias[k]||0);} }
  gTent&&gTent.destroy(); gRec&&gRec.destroy();
  gTent=new Chart($("cTent"),{type:"line",data:{labels:lab,datasets:[{label:"Tentativas",data:val,borderColor:"#2563eb",backgroundColor:"rgba(37,99,235,.15)",fill:true,tension:.25,pointRadius:3}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,ticks:{precision:0}}}}});
  gRec=new Chart($("cRec"),{type:"doughnut",data:{labels:["Recuperado","Em aberto"],datasets:[{data:[rec,abertoC],backgroundColor:["#16a34a","#ea580c"]}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{tooltip:{callbacks:{label:c=>c.label+": "+brl(c.parsed)}}}}});
}
$("rel").onclick=carregar; carregar(); setInterval(carregar,300000);
})();
