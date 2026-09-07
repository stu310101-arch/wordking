const M=(text,positions=['verb'])=>(positions.length?positions:['other']).map(partOfSpeech=>({partOfSpeech,definitions:[...new Set(text.split(/[;；]/).filter(Boolean))]}));
module.exports={M};
