const DAB_CHANNELS = [
  { ch:0,  name:'5A',  freq:174.928 }, { ch:1,  name:'5B',  freq:176.640 },
  { ch:2,  name:'5C',  freq:178.352 }, { ch:3,  name:'5D',  freq:180.064 },
  { ch:4,  name:'6A',  freq:181.936 }, { ch:5,  name:'6B',  freq:183.648 },
  { ch:6,  name:'6C',  freq:185.360 }, { ch:7,  name:'6D',  freq:187.072 },
  { ch:8,  name:'7A',  freq:188.928 }, { ch:9,  name:'7B',  freq:190.640 },
  { ch:10, name:'7C',  freq:192.352 }, { ch:11, name:'7D',  freq:194.064 },
  { ch:12, name:'8A',  freq:195.936 }, { ch:13, name:'8B',  freq:197.648 },
  { ch:14, name:'8C',  freq:199.360 }, { ch:15, name:'8D',  freq:201.072 },
  { ch:16, name:'9A',  freq:202.928 }, { ch:17, name:'9B',  freq:204.640 },
  { ch:18, name:'9C',  freq:206.352 }, { ch:19, name:'9D',  freq:208.064 },
  { ch:20, name:'10A', freq:209.936 }, { ch:21, name:'10B', freq:211.648 },
  { ch:22, name:'10C', freq:213.360 }, { ch:23, name:'10D', freq:215.072 },
  { ch:24, name:'11A', freq:216.928 }, { ch:25, name:'11B', freq:218.640 },
  { ch:26, name:'11C', freq:220.352 }, { ch:27, name:'11D', freq:222.064 },
  { ch:28, name:'12A', freq:223.936 }, { ch:29, name:'12B', freq:225.648 },
  { ch:30, name:'12C', freq:227.360 }, { ch:31, name:'12D', freq:229.072 },
  { ch:32, name:'13A', freq:230.784 }, { ch:33, name:'13B', freq:232.496 },
  { ch:34, name:'13C', freq:234.208 }, { ch:35, name:'13D', freq:235.776 },
  { ch:36, name:'13E', freq:237.488 }, { ch:37, name:'13F', freq:239.200 }
]

const AUDIO_MODES = ['4', '5']

const state = {
  service:      null,
  serviceType:  null,
  tune:         null,
  ensemble:     null,
  ensembleName: null,
  ecc:          null,
  dabTime:      null,
  servicesList: [],
  serviceInfo:  {},
  dynamicLabel: null,
  dlPlus:       {},
  signal:       {},
  debug:        {},
  slideshow:    null,
  enabled:      false,
  scanResults:  new Array(38).fill(null),
  scanning:     false,
  scanStatus:   null,
  _cachedServicesList: null
}

function getScanResultsCompact() {
  return Array.from({ length: 38 }, (_, i) => state.scanResults[i] || null)
}

module.exports = { state, DAB_CHANNELS, AUDIO_MODES, getScanResultsCompact }
