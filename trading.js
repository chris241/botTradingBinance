const ccxt = require("ccxt");
const { RSI } = require("technicalindicators");
const fs = require("fs");
require("dotenv").config();

// =================================================================
// --- ⚙️ CONFIGURATION DU BOT ---
// =================================================================
const API_KEY = process.env.BINANCE_API_KEY;
const SECRET_KEY = process.env.BINANCE_SECRET;
// Montant en USDT utilisé pour chaque nouvel achat
const CAPITAL_PAR_TRADE = parseFloat(process.env.CAPITAL_PAR_TRADE) || 10;

// --- CONFIGURATION DE SCAN ---
const BASE_QUOTE = "USDT";
const TIMEFRAME = "1m"; // Très court pour le gain rapide
// Intervalle de la boucle de scan (10 secondes)
const INTERVALLE_EXECUTION_MS = 1000 * 10;
// Limite aux 5 symboles les plus liquides
const MAX_SYMBOLS_TO_SCAN = 5;

// --- FILTRES DE QUALITÉ ---
const MIN_VOLUME_USDT = 500000;
const MIN_PRICE_USDT = 0.005;
// ------------------------------------------

// --- PARAMÈTRES D'INDICATEURS ET DE RISQUE (Optimisé pour Scalping Léger) ---
const RSI_PERIOD = 14;
const SEUIL_ACHAT = 35; // Augmenté de 30 à 35 pour entrer plus tôt sur les rebonds
const SEUIL_VENTE = 65; // Réduit de 70 à 65 pour sortir plus tôt en cas de baisse
const LATENCE_SYNC_MS = 3000;

// Variables de gestion des risques (en pourcentage)
const TAKE_PROFIT_PC = 0.05; // 🎯 RÉDUIT : TP à 0.05% pour sécuriser les petits gains rapidement
const STOP_LOSS_PC = 0.03; // 🛡️ RÉDUIT : SL à 0.03% pour limiter les pertes au maximum

// --- PERSISTANCE ---
const POSITIONS_FILE = "positions.json";

let SYMBOLS = [];
let globalState = {
  GLOBAL_PROFIT_USDT: 0.0,
  TRADES_BY_SYMBOL: {},
};

// --- INITIALISATION DE CCXT ---
if (!API_KEY || !SECRET_KEY) {
  console.error(
    "🚨 ERREUR : Les clés API sont manquantes. Veuillez remplir le fichier .env."
  );
  process.exit(1);
}

const exchange = new ccxt.binance({
  apiKey: API_KEY,
  secret: SECRET_KEY,
  enableRateLimit: true,
  options: {
    adjustForTimeDifference: true,
  },
});

// =================================================================
// --- FONCTIONS DE DÉMARRAGE ET UTILITAIRES ---
// =================================================================

/**
 * Récupère tous les symboles, les filtre par qualité, les trie par volume, et applique la limite MAX_SYMBOLS_TO_SCAN.
 */
async function fetchAllSymbols() {
  console.log(
    `\n⏳ Récupération, filtrage et sélection des ${MAX_SYMBOLS_TO_SCAN} meilleurs symboles /${BASE_QUOTE}...`
  );
  try {
    const [markets, tickers] = await Promise.all([
      exchange.fetchMarkets(),
      exchange.fetchTickers(),
    ]);

    let filteredSymbolsWithData = [];

    for (const market of markets) {
      const symbol = market.symbol;
      const ticker = tickers[symbol];

      if (
        market.quote === BASE_QUOTE &&
        market.active === true &&
        ticker &&
        ticker.quoteVolume &&
        ticker.last
      ) {
        if (
          ticker.quoteVolume >= MIN_VOLUME_USDT &&
          ticker.last >= MIN_PRICE_USDT
        ) {
          filteredSymbolsWithData.push({
            symbol: symbol,
            volume: ticker.quoteVolume,
          });
        }
      }
    }

    console.log(
      `Paires /${BASE_QUOTE} filtrées par Volume/Prix: ${filteredSymbolsWithData.length}.`
    );

    // Trier par Volume décroissant
    filteredSymbolsWithData.sort((a, b) => b.volume - a.volume);

    // Appliquer la limite
    const topSymbols = filteredSymbolsWithData
      .slice(0, MAX_SYMBOLS_TO_SCAN)
      .map((item) => item.symbol);

    console.log(`✅ Sélection finale : ${topSymbols.length} symboles retenus.`);
    return topSymbols;
  } catch (e) {
    console.error(
      "🚨 ERREUR lors de la récupération des symboles de Binance:",
      e.message
    );
    return ["ETH/USDT", "BTC/USDT", "ADA/USDT", "SOL/USDT", "XRP/USDT"].slice(
      0,
      MAX_SYMBOLS_TO_SCAN
    );
  }
}

function loadState() {
  try {
    const data = fs.readFileSync(POSITIONS_FILE, "utf8");
    globalState = JSON.parse(data);
    console.log(`✅ État global chargé depuis ${POSITIONS_FILE}.`);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.warn(
        `⚠️ Fichier ${POSITIONS_FILE} non trouvé. Création de l'état initial.`
      );
    } else {
      console.error("🚨 ERREUR lors du chargement de l'état:", error.message);
    }
  }

  if (!globalState.TRADES_BY_SYMBOL) {
    globalState.TRADES_BY_SYMBOL = {};
  }

  SYMBOLS.forEach((symbol) => {
    if (!globalState.TRADES_BY_SYMBOL[symbol]) {
      globalState.TRADES_BY_SYMBOL[symbol] = {
        profitTotalUSDT: 0.0,
        positionsOuvertes: [],
      };
    }
  });
}

function saveState() {
  try {
    fs.writeFileSync(
      POSITIONS_FILE,
      JSON.stringify(globalState, null, 2),
      "utf8"
    );
  } catch (error) {
    console.error("🚨 ERREUR lors de la sauvegarde de l'état:", error.message);
  }
}

function getCurrencies(symbol) {
  const parts = symbol.split("/");
  return { base: parts[0], quote: parts[1] };
}

async function calculateRSI(closes, period) {
  if (closes.length < period) return null;
  try {
    const rsiValues = RSI.calculate({ period: period, values: closes });
    return rsiValues.pop();
  } catch (e) {
    return null;
  }
}

/**
 * Arrondit la quantité à la précision requise par l'échange (Binance).
 */
function preciseAmount(symbol, amount) {
  const market = exchange.market(symbol);
  if (!market) {
    throw new Error(`Marché non trouvé pour le symbole: ${symbol}`);
  }
  const precision = market.precision.amount;
  return exchange.decimalToPrecision(
    amount,
    ccxt.ROUND,
    precision,
    ccxt.TICK_SIZE
  );
}

// =================================================================
// --- FONCTION DE FERMETURE EN URGENCE (closeAllPositions) ---
// =================================================================

async function closeAllPositions() {
  console.warn(
    "\n🔴 DÉMARRAGE DE L'ARRÊT D'URGENCE : Fermeture de TOUTES les positions ouvertes."
  );
  let closedCount = 0;

  await exchange.loadMarkets();

  for (const symbol in globalState.TRADES_BY_SYMBOL) {
    const symbolState = globalState.TRADES_BY_SYMBOL[symbol];

    if (symbolState.positionsOuvertes.length > 0) {
      console.log(`\n[Vente ${symbol}] Tentative de fermeture.`);

      try {
        const balance = await exchange.fetchBalance();
        const { base } = getCurrencies(symbol);
        const soldeReel = balance.free[base] || 0;

        if (soldeReel > 0) {
          const quantiteAVendre = preciseAmount(symbol, soldeReel);

          if (parseFloat(quantiteAVendre) > 0) {
            await exchange.createMarketSellOrder(
              symbol,
              parseFloat(quantiteAVendre)
            );

            console.log(
              `🟢 VENTE MARCHE RÉUSSIE pour ${symbol}. Quantité vendue: ${quantiteAVendre}.`
            );
            closedCount++;

            symbolState.positionsOuvertes = [];
            await new Promise((resolve) =>
              setTimeout(resolve, LATENCE_SYNC_MS)
            );
          } else {
            console.log(
              `🟡 Pas de solde réel à vendre pour ${symbol} après arrondi.`
            );
          }
        } else {
          console.log(`🟡 Le solde réel pour ${symbol} est déjà zéro.`);
        }
      } catch (sellError) {
        console.error(
          `🚨 ERREUR CRITIQUE lors de la vente de ${symbol}: ${sellError.message}`
        );
      }
    }
  }

  saveState();

  console.warn(
    `\n✅ ARRÊT D'URGENCE TERMINÉ. ${closedCount} ordre(s) de vente au marché exécuté(s).`
  );
  console.warn(
    "Veuillez commenter l'appel à closeAllPositions() si vous voulez reprendre le trading."
  );
  process.exit(0);
}

// =================================================================
// --- LOGIQUE D'AFFICHAGE (PNL, SL, TP) ---
// =================================================================

async function displayOpenPositions(usdtDisponible) {
  let hasOpenPositions = false;
  let bestProfitPercent = -Infinity;
  let bestPositionInfo = null;

  console.log("\n--- 💼 POSITIONS OUVERTES ---");
  console.log(`💰 SOLDE USDT DISPONIBLE : ${usdtDisponible.toFixed(2)} USDT`);
  console.log(
    `📈 PROFIT NET GLOBAL RÉALISÉ : ${globalState.GLOBAL_PROFIT_USDT.toFixed(
      2
    )} USDT`
  );
  console.log("-----------------------------\n");

  const tickers = await exchange.fetchTickers(SYMBOLS).catch(() => {});

  for (const symbol in globalState.TRADES_BY_SYMBOL) {
    const symbolState = globalState.TRADES_BY_SYMBOL[symbol];

    if (symbolState.positionsOuvertes.length > 0) {
      hasOpenPositions = true;

      const prixActuel =
        tickers && tickers[symbol] ? tickers[symbol].last : null;
      const profitTotalSymbole = symbolState.profitTotalUSDT;

      console.log(
        `\n[${symbol}] 💹 Profit Total Réalisé sur ce symbole: ${profitTotalSymbole.toFixed(
          2
        )} USDT`
      );

      symbolState.positionsOuvertes.forEach((pos) => {
        const quantite = pos.quantite;
        const prixAchat = pos.prixAchat;

        let pnlNonRealisé = 0;
        let pnlPercent = 0;

        // Calcul des prix de SL et TP pour l'affichage
        const stopLossPrix = prixAchat * (1 - STOP_LOSS_PC);
        const takeProfitPrix = prixAchat * (1 + TAKE_PROFIT_PC);

        if (prixActuel) {
          pnlNonRealisé = (prixActuel - prixAchat) * quantite;
          pnlPercent = (pnlNonRealisé / (prixAchat * quantite)) * 100;

          // Vérifier si c'est la meilleure position
          if (pnlPercent > bestProfitPercent) {
            bestProfitPercent = pnlPercent;
            bestPositionInfo = {
              symbol: symbol,
              pnlPercent: pnlPercent,
              pnlUSDT: pnlNonRealisé,
            };
          }
        }

        const signe = pnlNonRealisé >= 0 ? "📈" : "📉";

        console.log(
          `  ${signe} ID ${pos.id} | Qte: ${quantite.toFixed(
            5
          )} | Achat: ${prixAchat.toFixed(4)} | Actuel: ${
            prixActuel ? prixActuel.toFixed(4) : "N/A"
          }`
        );
        if (prixActuel) {
          console.log(
            `    PNL Non Réalisé: ${pnlNonRealisé.toFixed(
              2
            )} USDT (${pnlPercent.toFixed(2)}%)`
          );
          console.log(
            `    ⚠️ SL: ${stopLossPrix.toFixed(
              4
            )} (Perte à ${STOP_LOSS_PC}%) | ✅ TP: ${takeProfitPrix.toFixed(
              4
            )} (Gain à ${TAKE_PROFIT_PC}%)`
          );
        }
      });
    }
  }

  if (!hasOpenPositions) {
    console.log("  Aucune position ouverte n'est gérée par le bot.");
  }

  // Afficher la meilleure position à la fin
  if (bestPositionInfo) {
    console.log("\n==================================");
    console.log(`🥇 MEILLEUR GAIN ACTUEL : ${bestPositionInfo.symbol}`);
    console.log(
      `   ${bestPositionInfo.pnlPercent.toFixed(
        2
      )}% | ${bestPositionInfo.pnlUSDT.toFixed(2)} USDT`
    );
    console.log("==================================");
  }
}

async function syncPositionsWithBinance(symbol) {
  const { base } = getCurrencies(symbol);
  const symbolState = globalState.TRADES_BY_SYMBOL[symbol];

  // Si le bot a déjà des positions enregistrées, on ne fait rien
  if (symbolState.positionsOuvertes.length > 0) {
    return;
  }

  let balance;
  let ticker;
  try {
    [balance, ticker] = await Promise.all([
      exchange.fetchBalance(),
      exchange.fetchTicker(symbol).catch(() => null),
    ]);
  } catch (e) {
    return;
  }

  const soldeBinance = balance.free[base] || 0;
  const prixActuel = ticker ? ticker.last : null;

  // Si un solde non-USDT > 0.0001 est trouvé et non géré
  if (soldeBinance > 0.0001 && prixActuel) {
    console.warn(
      `\n⚠️ ACTIF NON GÉRÉ DÉTECTÉ pour ${symbol}: Solde ${base}: ${soldeBinance.toFixed(
        5
      )}.`
    );

    const nouvellePosition = {
      id: Date.now(),
      prixAchat: prixActuel,
      quantite: soldeBinance,
      timestamp: new Date().toISOString(),
      source: "SYNC_API",
    };

    symbolState.positionsOuvertes.push(nouvellePosition);
    saveState();

    console.log(`✅ POSITION VIRTUELLE CRÉÉE pour ${symbol}.`);
  }
}

async function executerBot() {
  console.log(
    `\n[${new Date().toLocaleTimeString()}] Début de l'analyse des ${
      SYMBOLS.length
    } symboles (Toutes les ${INTERVALLE_EXECUTION_MS / 1000}s)...`
  );

  let usdtDisponible = 0;
  try {
    const balance = await exchange.fetchBalance();
    usdtDisponible = balance.free.USDT || 0;
  } catch (e) {
    console.error("🚨 ERREUR FATALE D'AUTHENTIFICATION/BALANCE:", e.message);
    return;
  }

  // Affiche le solde, les positions et le meilleur gain
  await displayOpenPositions(usdtDisponible);

  console.log("Capital par trade : " + CAPITAL_PAR_TRADE + " USDT");
  console.log("-----------------------------------------");

  for (const symbol of SYMBOLS) {
    try {
      const result = await processSymbol(symbol, usdtDisponible);

      // Met à jour le solde si une transaction (achat/vente) a eu lieu
      if (result.needsBalanceUpdate) {
        const currentBalance = await exchange.fetchBalance();
        usdtDisponible = currentBalance.free.USDT || 0;
      }
    } catch (error) {
      // Évite que le crash d'un symbole ne stoppe l'intégralité du bot
    }
  }
}

async function processSymbol(symbol, usdtDisponible) {
  const symbolState = globalState.TRADES_BY_SYMBOL[symbol];
  const { base } = getCurrencies(symbol);

  // Condition pour sauter le symbole si pas de capital et pas de position ouverte
  if (
    symbolState.positionsOuvertes.length === 0 &&
    usdtDisponible < CAPITAL_PAR_TRADE
  ) {
    return { needsBalanceUpdate: false };
  }

  // 1. RÉCUPÉRER LES DONNÉES
  const ohlcv = await exchange.fetchOHLCV(
    symbol,
    TIMEFRAME,
    undefined,
    RSI_PERIOD + 2
  );
  const closes = ohlcv.map((candle) => candle[4]);
  const prixActuel = closes[closes.length - 1];

  // 2. CALCULER LES INDICATEURS
  const rsiActuel = await calculateRSI(closes, RSI_PERIOD);
  const rsiPrecedent = await calculateRSI(
    closes.slice(0, closes.length - 1),
    RSI_PERIOD
  );

  if (rsiActuel === null || rsiPrecedent === null) {
    return { needsBalanceUpdate: false };
  }

  let needsSave = false;
  let needsBalanceUpdate = false;

  // 3. GESTION ET FERMETURE DES POSITIONS EXISTANTES (SL/TP/RSI)
  const positionsAFermer = [];

  symbolState.positionsOuvertes.forEach((pos) => {
    const prixAchat = pos.prixAchat;
    const stopLossPrix = prixAchat * (1 - STOP_LOSS_PC);
    const takeProfitPrix = prixAchat * (1 + TAKE_PROFIT_PC);

    // Conditions de clôture (SL/TP/RSI)
    if (prixActuel <= stopLossPrix) {
      positionsAFermer.push({ ...pos, motif: "STOP_LOSS" });
    } else if (prixActuel >= takeProfitPrix) {
      positionsAFermer.push({ ...pos, motif: "TAKE_PROFIT" });
    } else if (rsiActuel < SEUIL_VENTE && rsiPrecedent >= SEUIL_VENTE) {
      positionsAFermer.push({ ...pos, motif: "RSI_VENTE" });
    }
  });

  if (positionsAFermer.length > 0) {
    console.log(
      `[Vente ${symbol}] ${positionsAFermer.length} position(s) à fermer.`
    );
    for (const pos of positionsAFermer) {
      try {
        const quantiteAVendre = preciseAmount(symbol, pos.quantite);

        // Exécution de l'ordre de vente
        await exchange.createMarketSellOrder(
          symbol,
          parseFloat(quantiteAVendre)
        );

        // Calcul du profit réalisé pour l'enregistrement
        const profitPosition =
          (prixActuel - pos.prixAchat) * parseFloat(quantiteAVendre);
        symbolState.profitTotalUSDT += profitPosition;
        globalState.GLOBAL_PROFIT_USDT += profitPosition;

        const signe = profitPosition >= 0 ? "🟢" : "🔴";
        console.log(
          `[${signe} VENTE ${symbol}] Gain: ${profitPosition.toFixed(
            4
          )} USDT. Motif: ${pos.motif}`
        );

        // Suppression de la position fermée de la liste
        symbolState.positionsOuvertes = symbolState.positionsOuvertes.filter(
          (p) => p.id !== pos.id
        );
        needsSave = true;
        needsBalanceUpdate = true;
      } catch (sellError) {
        console.error(
          `Erreur lors de la vente de la position sur ${symbol}:`,
          sellError.message
        );
        const balance = await exchange.fetchBalance();

        console.log(
          "le solde de compte est usdt: ",
          (usdtDisponible = balance.free.USDT || 0)
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, LATENCE_SYNC_MS));
  }

  // 4. VÉRIFICATION DES SIGNAUX (ENTRÉE : ACHAT)
  if (rsiActuel > SEUIL_ACHAT && rsiPrecedent <= SEUIL_ACHAT) {
    // Vérification du capital disponible
    if (usdtDisponible < CAPITAL_PAR_TRADE) {
      console.log(
        `[ACHAT ${symbol}] Solde USDT insuffisant (${usdtDisponible.toFixed(
          2
        )} USDT < ${CAPITAL_PAR_TRADE} USDT).`
      );
      return { needsBalanceUpdate: false };
    }

    console.log(
      `[ACHAT ${symbol}] Signal RSI détecté. (RSI: ${rsiActuel.toFixed(2)})`
    );

    // Calcul de la quantité et application de la précision
    const quantiteAcheterInitial = CAPITAL_PAR_TRADE / prixActuel;
    const quantiteAcheter = preciseAmount(symbol, quantiteAcheterInitial);

    try {
      // Exécution de l'ordre d'achat
      const ordre = await exchange.createMarketBuyOrder(
        symbol,
        parseFloat(quantiteAcheter)
      );

      // Enregistrement de la nouvelle position ouverte
      const nouvellePosition = {
        id: Date.now(),
        prixAchat: prixActuel,
        quantite: ordre.filled || parseFloat(quantiteAcheter),
        timestamp: new Date().toISOString(),
      };
      symbolState.positionsOuvertes.push(nouvellePosition);

      console.log(
        `[ACHAT ${symbol}] ${nouvellePosition.quantite.toFixed(
          5
        )} de ${base} acheté.`
      );

      needsSave = true;
      needsBalanceUpdate = true;
      await new Promise((resolve) => setTimeout(resolve, LATENCE_SYNC_MS));
    } catch (buyError) {
      console.error(`Erreur lors de l'achat sur ${symbol}:`, buyError.message);
    }
  }

  if (needsSave) {
    saveState();
  }

  return { needsBalanceUpdate };
}

// =================================================================
// --- BOUCLE D'EXÉCUTION EN TEMPS RÉEL ---
// =================================================================

async function startBot() {
  // 1. Récupérer les 5 meilleurs symboles
  SYMBOLS = await fetchAllSymbols();

  // 2. Charger l'état
  loadState();

  // 3. Charger les marchés pour obtenir les précisions (nécessaire pour ccxt)
  await exchange.loadMarkets();

  // ---------------------------------------------------------------------
  // ⚠️ ACTION REQUISE POUR FERMER TOUT : DÉCOMMENTER LA LIGNE CI-DESSOUS ⚠️
  // ---------------------------------------------------------------------
  // await closeAllPositions();
  // ---------------------------------------------------------------------

  // 4. Synchroniser les positions
  for (const symbol of SYMBOLS) {
    await syncPositionsWithBinance(symbol);
  }

  console.log("\n--- DÉMARRAGE DU BOT OPTIMISÉ ---");
  console.log(`Mode : Scalping Léger (Gains Rapides)`);
  console.log(
    `TP: ${TAKE_PROFIT_PC}% | SL: ${STOP_LOSS_PC}% | RSI Achat: ${SEUIL_ACHAT}`
  );
  console.log(
    `Analyse de ${
      SYMBOLS.length
    } symboles sur ${TIMEFRAME}. Exécution toutes les ${
      INTERVALLE_EXECUTION_MS / 1000
    } secondes.`
  );

  // Exécution initiale et planification
  executerBot();
  setInterval(executerBot, INTERVALLE_EXECUTION_MS);
}

startBot();
