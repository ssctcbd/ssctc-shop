# SSCTC Shop — change notes

Software ta byabohar kore dekhar shomoy ja ja bodlate ba jog korte hobe, tar list.
Ekhane shudhu note thake; kaaj shuru hoy malik bolar por, shob ekshathe.

Obostha: **Baki** = ekhono kora hoy ni · **Hoyeche** = kora ar upload er jonno toiri

---

## 1. Owner er jonno "Forgot password"

- **Obostha:** Hoyeche (2026-10-27) — recovery code poddhoti (malik beche niyechen). Owner Password screen theke 10 ta code banaben; login page e "Forgot password?" diye ekta code r notun password.
- **Note neya:** 2026-10-11
- **Ki chai:** Owner password bhule gele login page theke nije notun password boshate parbe. Staff er jonno eta lagbe na; staff er password Owner-i Users screen theke bodle dey.
- **Ekhon ki ache:** Login page e kono "Forgot password" nei. Owner bhule gele cPanel/phpMyAdmin diye boshate hoy.
- **Kaaj shuru korar age thik korte hobe:**
  - Kon poddhoti: email e reset link (ekta email account lagbe), na age theke toiri kora recovery code.
  - Email hole: kon email thikanay link jabe.
- **Mone rakhar moto:** link ta login page e shobai dekhbe, kintu reset shudhu Owner er email/code diye-i hobe. Notun table lagbe, tai ekta notun migration (`005`) ar API + website dui zip-i abar upload korte hobe.

## 2. Customer er portal login WhatsApp e pathano

- **Obostha:** Hoyeche (2026-10-27)
- **Note neya:** 2026-10-11
- **Ki chai:** Customer toiri korar por (ar PIN reset korar por) ekta "Send on WhatsApp" button. Chaple WhatsApp khulbe, customer er number ar portal er thikana, mobile number o PIN lekha message age thekei boshano thakbe; shudhu Send chapte hobe.
- **Ekhon ki ache:** PIN shudhu screen e dekhay; customer ke mukhe bolte hoy.
- **Mone rakhar moto:** message jabe dokaner nijer WhatsApp theke, tai kono khoroch nei ar kono notun service lage na. Purota nije theke pathano (click chhara) hobe na. Shudhu website er zip abar upload korte hobe; database e kichu bodlabe na.

## 3. Login page e "Staff login" er jaygay "Shop login"

- **Obostha:** Hoyeche (2026-10-27)
- **Note neya:** 2026-10-11
- **Ki chai:** Login page er shironam "Staff login" bodle "Shop login" hobe.
- **Ekhon ki ache:** "Staff login" lekha, jodio Owner ar Staff duijon-i ei page diye dhoke.
- **Mone rakhar moto:** shudhu lekha bodol; login er niyom ba nirapottay kichu bodlabe na. Customer der alada link ("Open the customer portal") jemon ache temon thakbe. Shudhu website er zip abar upload korte hobe.

## 4. Opening due shudhu Owner tulte parbe

- **Obostha:** Hoyeche (2026-10-27) — notun onumoti `customers.opening_due`, migration `005` e.
- **Note neya:** 2026-10-11
- **Ki chai:** Customer er purono baki (Opening due) tolar button ar khomota shudhu Owner er kache thakbe. Staff customer jog korte ar naam-number bodlate parbe age-r motoi.
- **Ekhon ki ache:** Staff o Opening due tulte pare, karon eta customer bodlanor eki onumoti-r (customers.manage) bhitore.
- **Mone rakhar moto:** eta ekmatro jayga jekhane kono bikri chhara karo naame baki boshano jay, tai malik er hate rakha hocche. Ekta notun onumoti lagbe ja shudhu Owner pabe: chhoto ekta migration (`005`, onno note er shathe eki file e jete pare), ar API + website dui zip-i abar upload korte hobe.

## 5. Browser er nijer pop-up box er jaygay shop er nijer design er box

- **Obostha:** Hoyeche (2026-10-27) — 6 ta jaygay-i (abar khuje dekha hoyeche, notun kono box chilo na). Ekta shadharon box (`web/components/Dialogs.js`), nil button, Enter = hya, Escape = batil.
- **Note neya:** 2026-10-11
- **Ki chai:** Jekhane jekhane browser er nijer box ashe ("shop.sscomputertrainingcentre.com says ..."), shekhane shop er nijer box hobe:
  - screen er majhkhane shada box,
  - shop er nil button,
  - porishkar shironam,
  - Void er khetre karon lekhar jonno thik-thak ekta lekhar ghor (ekhonkar chhoto ek-line er ghor na).
- **Ekhon ki ache:** nishchit korar proshno ar Void er karon browser er toiri box e ashe; rong, jayga ar button shop er design er shathe mile na.
- **Jekhane jekhane bodlate hobe** (code khuje ber kora, 2026-10-11; mot 6 jayga):
  1. Customers → **Reset PIN** (nishchit korar proshno)
  2. Users → **Block** (nishchit korar proshno)
  3. Sales → bikri-r bhitore payment **Void** (karon)
  4. Payments → **Void** (karon)
  5. Expenses → **Void** (karon)
  6. Suppliers → Payments → **Void** (karon)
- **Malik er shorto:** kono file jeno na bhange, kichu jeno bad na pore, kono bhul jeno na thake.
- **Kaaj er shomoy ja mante hobe:**
  - Kaaj shuru te abar khuje dekhte hobe notun kono browser box jog hoyeche ki na; ekta-o baki rakha jabe na.
  - Kaaj ta eki thakbe: Cancel chaple kichu bodlabe na; Void e karon kompokkhe 3 okkhor na hole save hobe na.
  - Ekta-i shadharon box baniye shob jaygay byabohar korte hobe, jate shob jaygay dekhte eki hoy.
  - Box er lekha ingreji-tei thakbe, software er baki screen er motoi (jemon "Issue a new portal PIN for ...?"). Ei note er Banglish shudhu bojhanor jonno.
  - Keyboard e cholte hobe (Enter = hya, Escape = batil), mobile e-o thik dekhate hobe.
  - Shesh e protita jayga browser e chaliye dekhte hobe, ar API er shob test abar pass korte hobe.
- **Mone rakhar moto:** shudhu website er bodol; database ba API te kichu bodlabe na. Shudhu website er zip abar upload korte hobe.

## 6. Logo ar favicon (browser tab er icon) bodlano

- **Obostha:** Hoyeche (2026-10-27) — malik er file `Logo\SSCTC Logo final-01.svg` (shudhu "SS" chinho). Chinho ta `web\public\brand\ssctc-mark.svg` e; pashe "SS COMPUTER / TRAINING CENTRE" lekha ta website nije likhe, purono logo-r rong e. Favicon o eki chinho theke (`favicon.svg`). Purono PNG ta muche deya hoyeche. Thermal bill e logo age-r motoi nei.
- **Note neya:** 2026-10-11
- **Ki chai:** Software er logo ar browser tab er chhoto icon (favicon) bodle malik er deya file boshate hobe. Kaaj ta developer korbe (Claude), Settings screen diye na.
- **Ekhon ki ache:**
  - Logo: malik er main website (`sscomputertrainingcentre.com`) theke namano file, onumoti chhara neya. Ache `web\public\brand\ssctc-logo.png` e.
  - Favicon: developer er nijer banano (nil ghore "SS"). Ache `web\public\brand\favicon.svg` e.
- **Kaaj shuru korar age malik ke dite hobe:**
  - Logo er file (PNG hole bhalo; pichhone shada ba shochchho, duitai chole).
  - Favicon er file (borgo akar er chhobi, PNG ba SVG). Na dile logo theke-i ekta baniye neya jay; tokhon malik ke dekhiye nite hobe.
  - File gulo project folder e rekhe naam bolle-i hobe.
- **Kaaj er shomoy ja mante hobe:**
  - Logo jekhane jekhane ashe shob jaygay dekhe nite hobe: login page, customer portal login, bam pasher menu, mobile er upor er bar, invoice (A4), payment receipt, customer statement, customer portal er bill.
  - Thermal (58mm/80mm) invoice e logo dekhano hoy na; eta jemon ache temon thakbe, jodi na malik onno kichu bole.
  - Notun logo r akar alada hole menu ar invoice e jeno chepe ba kete na jay.
- **Mone rakhar moto:** shudhu website er bodol; database ba API te kichu bodlabe na. Shudhu website er zip abar upload korte hobe. Settings screen theke Owner nije logo bodlanor subidha ei note e **nei**; seta chaile alada note hobe.

## 7. POS e "All / Products / Services" button

- **Obostha:** Hoyeche (2026-10-27) — scan kora code je button-i beche thakuk khuje ney ar barta dekhay; dropdown shop er design e; purchase screen er khojar ghor bodlano hoy ni.
- **Note neya:** 2026-10-11
- **Ki chai:** POS / New sale screen e "Add product or service" er upore tin ta button: **All · Products · Services**. Je ta beche neya, search e shudhu shei dhoron dekhabe.
  - **All:** shob ekshathe, ekhon jemon ache. Shuru te eta-i beche thakbe.
  - **Products:** search e shudhu product.
  - **Services:** search e shudhu service.
- **Ekhon ki ache:** product ar service ek list e mishe ashe; alada korar upay nei.
- **Shathe ja ja korte hobe:**
  1. **Beche neya button mone rakha:** je button beche neya hoyeche, porer bikri te-o (ar page abar khulle-o) oi computer e seta-i beche thakbe.
  2. **Button e shonkhya:** "Products (120)", "Services (14)" er moto.
  3. **Search er dropdown list ta shop er design e ana:** ekhon list ta browser er nijer kalo box e ashe. Eta shop er shada-nil design er list hobe (5 nombor note er motoi bhabna). Eta baki duitar cheye boro kaaj.
- **Kaaj er shomoy ja mante hobe:**
  - **Barcode scanner:** "All" ba "Products" beche thakle scan kora code age-r motoi shorashori bill e uthbe. "Services" beche thaka obosthay product scan korle chup kore kichu na hoye, porishkar barta dekhate hobe (ba nije theke product ta khuje nite hobe); cashier jeno na atke.
  - Ek bill e product ar service duitai tola jabe, button bodlale bill er age-r line gulo jeno na muche.
  - Dropdown bodlale keyboard diye cholte hobe (teer chinho diye beche Enter), touch screen ar mobile e-o.
  - Notun purchase er screen e-o eki product khojar ghor byabohar hoy; okhane jeno kichu na bhange.
- **Mone rakhar moto:** shudhu website er bodol; database ba API te kichu bodlabe na. Shudhu website er zip abar upload korte hobe.

---

## 8. Staff commission ar daily cash er notun niyom

- **Obostha:** Hoyeche (2026-10-27)
- **Note neya:** 2026-10-27
- **Ki chai:** Staff commission e kaaj korbe. Shokale ager diner cash gune entry; je staff kaaj korbe se nijer account theke entry dibe ar nijer commission nijer account e dekhbe (stationary theke-o). Raate owner ke hishab bujhiye dibe (shokale koto chilo, khoroch koto, ekhon koto). Owner raate taka nite pare ba na-o pare; baki ta drawer e thake, porer shokal oi taka theke hishab shuru.
- **Malik er shiddhanto:** commission item onujayi (% ba protita unit e taka) — service e ar product category te; baki bikri te-o bikri hole-i commission (void/return e kete jay); shokale opening na dile kono bikri hobe na; Owner nije commission pay na.
- **Ki kora hoyeche:** Cash screen e Open (shokal) → Hand over (raat, staff-o parbe) → Owner er "Receive cash". Commission screen (Owner: shobar hishab ar Pay; Staff: My commission). Services/Categories e rate er ghor. Users e "Earns commission". Lab-khotir report ar dashboard e commission khoroch hishebe bad.
- **Mone rakhar moto:** notun migration `005`, ar API + website dui zip-i abar upload korte hobe. Upload er por prothom kaaj: Cash screen theke drawer gune "Open the cash", noile kono bikri save hobe na.

## 9. Owner er password email e OTP diye

- **Obostha:** Hoyeche, live e pariksha kora (2026-11-01)
- **Ki chai:** Forgot password e Owner er email e code jabe (SMS na, tai khoroch nei). Recovery code-o thakbe.
- **Kivabe:** login page e Forgot password → username → 6 ongker code (10 minute, 5 try, ekbar-i). Staff er jonno kono mail jay na. Owner er email Password screen e boshe, password diye; save korle test mail jay.
- **Mone rakhar moto:** migration `006`, `package.json` e notun package (`nodemailer`, Run NPM Install lagbe), cPanel e ekta mailbox, ar server er `.env` e `SMTP_*`.

## 10. Ek ek staff er jonno alada commission rate

- **Obostha:** Code hoyeche (2026-11-01); server e boshano baki
- **Ki chai:** Shadharon rate er pashapashi kono staff er jonno alada rate deya jabe.
- **Kivabe:** Commission screen e staff er pashe **Rates**. Alada rate shudhu jekhane dorkar; na dile shadharon rate-i cholbe. 0 dile oi item e oi staff kichu pabe na. Product e age tar category er rate, tarpor mul category er rate, tarpor shadharon rate.
- **Mone rakhar moto:** rate bodlale purono bikrir commission bodlay na. Staff shudhu nijer rate dekhe (My commission). Migration `007` ar API + website dui zip-i upload korte hobe.

## Notun note jog korar niyom

Protita note e: ki chai, ekhon ki ache, ar kaaj shuru korar age kono proshno baki thakle seta.
