# HoloVault — scanner & coffre-fort de cartes à collectionner

Application web installable sur téléphone (PWA) : **Pokémon**, **Magic** et **Yu-Gi-Oh!**.
Aucune inscription, aucun serveur : la collection reste **uniquement sur ton téléphone**.

## Fonctionnalités

| | |
|---|---|
| 📷 **Scanner** | Cadre-guide, flash, import depuis la galerie. Lecture du nom + numéro (ex. `051/064`) directement sur le téléphone (OCR), puis identification de la bonne carte. |
| 🧠 **Identification** | Meilleure image parmi 4 prises (netteté), 3 lectures croisées, correction des mots lus avec le dictionnaire des vrais noms de cartes, puis comparaison visuelle photo ↔ cartes pour trouver la bonne édition. |
| 📌 **Série épinglée** | Choisis une série dans le menu et épingle-la : les scans suivants cherchent dedans (idéal pour ranger un booster ou un classeur). Même si le nom est illisible, la photo est comparée à toutes les cartes de la série. |
| 🔎 **Recherche manuelle** | Par nom (FR ou EN), numéro et **série** (menu déroulant groupé par génération), ou parcours complet d'une série. |
| 💶 **Prix du marché** | Cardmarket (€ : tendance, plus bas, moyennes 24 h / 7 j / 30 j) et TCGplayer ($). Verdict « en hausse / en baisse / stable », liens Cardmarket, TCGplayer et ventes eBay terminées. |
| 📈 **Analyse** | Valeur totale, plus-value vs prix d'achat, tendance du marché 30 j de ta collection, historique jour par jour, plus fortes hausses/baisses, top 10, répartition par jeu et par rareté, progression des séries. |
| 🗂️ **Archive** | Quantité, version (normale / holo / reverse / 1re éd.), état (NM → PO) avec décote automatique, gradation (PSA…), valeur perso, langue, notes, ta photo du scan. |
| ❤️ **Liste d'envies** | Suivre le prix des cartes que tu cherches, puis « Je l'ai eue ! » pour la passer en collection. |
| ✨ Confort | Doubles (pour les échanges), tri/filtre/recherche, vue grille ou liste, effet holographique au doigt/gyroscope, vibrations, mode hors ligne, FR/EN, € ou $, sauvegarde/restauration JSON, export CSV (Excel), partage de collection avec un ami. |

## Tester sur l'ordinateur

```powershell
powershell -ExecutionPolicy Bypass -File serve.ps1
```
Puis ouvre http://localhost:8080 (la caméra de l'ordinateur fonctionne sur `localhost`).

## Mettre l'appli sur ton téléphone

La caméra exige une adresse **https**. Le plus simple est d'héberger le dossier gratuitement :

**Option A — Netlify Drop (2 minutes)**
1. Va sur https://app.netlify.com/drop
2. Glisse-dépose le dossier `App Pokemon` entier.
3. Ouvre l'adresse `https://xxxx.netlify.app` obtenue sur ton téléphone.

**Option B — GitHub Pages**
1. Crée un dépôt GitHub, envoie-y ces fichiers.
2. *Settings → Pages → Deploy from branch → main / root*.
3. Ouvre `https://<ton-pseudo>.github.io/<depot>/`.

Puis **installe-la** :
- **iPhone (Safari)** : bouton Partager → « Sur l'écran d'accueil ».
- **Android (Chrome)** : menu ⋮ → « Installer l'application » (ou le bouton dans *Réglages*).

### Privée ou partagée ?
- **Privée** : garde l'adresse pour toi. Chaque appareil a sa propre collection, stockée localement.
- **À partager** : envoie l'adresse à tes amis, chacun aura sa propre collection.
  Pour montrer *ta* collection : *Réglages → Partager ma collection* (fichier que l'ami importe).

> ⚠️ Les données vivent dans le navigateur du téléphone : fais une **sauvegarde JSON** de temps en temps
> (Réglages → Sauvegarder), surtout avant de changer de téléphone.

## Conseils de scan
- Bonne lumière, sans reflet (incline légèrement les cartes holo).
- La carte doit remplir le cadre ; les zones pointillées montrent où l'appli lit le **nom** et le **numéro**.
- Le résultat reste modifiable : corrige le nom si besoin, la bonne carte est marquée « N° identique » ou « Ressemble le plus à ta photo ».
- Pour scanner beaucoup de cartes d'une même série : choisis-la dans le menu des séries et touche 📌.

## Sources de données (gratuites, sans clé)
- Pokémon : [TCGdex](https://tcgdex.dev) — prix Cardmarket & TCGplayer
- Magic : [Scryfall](https://scryfall.com/docs/api)
- Yu-Gi-Oh! : [YGOPRODeck](https://ygoprodeck.com/api-guide/)
- Taux de change : Frankfurter (BCE)

Prix indicatifs. Application non officielle, sans lien avec The Pokémon Company, Wizards of the Coast ou Konami.

## Structure
```
index.html            coquille de l'appli + barre d'onglets
css/styles.css        thème sombre holographique
js/app.js             écrans, logique, analyse
js/api.js             recherche & prix (TCGdex, Scryfall, YGOPRODeck)
js/scanner.js         caméra + OCR (Tesseract.js)
js/db.js              stockage local (IndexedDB)
js/charts.js          graphiques SVG
js/i18n.js            textes FR / EN
sw.js                 mode hors ligne
manifest.webmanifest  installation sur l'écran d'accueil
```
