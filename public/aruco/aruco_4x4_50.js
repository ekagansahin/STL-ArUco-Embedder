// ARUCO_4X4_50 — kendi tutarlı 4x4_1000 sözlüğümüzden seçilen, birbirine EN UZAK
// 50 marker (rotasyon-duyarlı max-min Hamming seçimi), ID'ler 0-49 olarak yeniden
// numaralandırıldı. Yoğun 4x4_1000'in aksine kodlar arası mesafe yüksek → tek bit
// hatasıyla başka geçerli ID'ye kayma pratikte imkansız. tau: null → kütüphane hesaplar.
AR.DICTIONARIES['ARUCO_4X4_50'] = {
  nBits: 16,
  tau: null,
  codeList: [[181,50],[15,154],[51,45],[153,70],[254,111],[84,158],[121,205],[196,242],[6,75],[45,20],[26,174],[74,194],[254,218],[249,145],[14,183],[70,101],[176,43],[204,213],[221,130],[24,117],[28,90],[147,122],[3,128],[59,231],[46,209],[36,177],[118,175],[172,228],[33,35],[68,21],[87,178],[158,207],[240,203],[9,41],[4,255],[23,24],[42,40],[50,140],[36,232],[45,63],[80,19],[81,148],[95,151],[104,1],[104,103],[97,233],[111,229],[126,27],[139,162],[132,108]]
};
