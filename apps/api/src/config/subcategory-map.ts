// Sub-category keyword taxonomy for CompetitorIntelligenceAgent.
// Each key is the canonical sub-category label stored in leads.sub_category
// and distributor_brand_portfolio.sub_category_hint.
// Classification scores each sub-category by keyword hit density against
// product titles; highest scorer above MIN_DENSITY wins.

export const MIN_DENSITY = 0.08; // at least 8% of tokens must match

export const SUBCATEGORY_MAP: Record<string, string[]> = {
  // food_beverage
  functional_beverages:   ['energy', 'electrolyte', 'hydration', 'nootropic', 'adaptogen drink', 'functional beverage', 'sports drink', 'kombucha', 'kefir'],
  snacks_bars:            ['snack', 'bar', 'granola', 'protein bar', 'energy bar', 'trail mix', 'jerky', 'chips', 'popcorn'],
  condiments_sauces:      ['sauce', 'hot sauce', 'condiment', 'dressing', 'marinade', 'seasoning', 'spice', 'salsa', 'mustard', 'ketchup'],
  plant_based_foods:      ['plant based', 'vegan', 'dairy free', 'meat alternative', 'oat milk', 'almond milk', 'tofu', 'tempeh'],
  coffee_tea:             ['coffee', 'tea', 'matcha', 'espresso', 'cold brew', 'herbal tea', 'chai'],
  confectionery:          ['chocolate', 'candy', 'gummy', 'sweet', 'confection', 'truffle', 'fudge'],

  // supplements
  collagen_beauty:        ['collagen', 'peptide', 'hyaluronic', 'biotin', 'beauty supplement', 'skin supplement', 'hair supplement'],
  protein_fitness:        ['protein', 'whey', 'creatine', 'bcaa', 'amino acid', 'pre-workout', 'post-workout', 'mass gainer'],
  cbd_hemp:               ['cbd', 'hemp', 'cannabidiol', 'full spectrum', 'broad spectrum'],
  vitamins_minerals:      ['vitamin', 'mineral', 'multivitamin', 'zinc', 'magnesium', 'iron', 'omega', 'fish oil', 'd3', 'b12'],
  mushroom_adaptogen:     ['mushroom', 'reishi', 'lion mane', 'chaga', 'ashwagandha', 'rhodiola', 'maca', 'adaptogen'],
  probiotics_gut:         ['probiotic', 'prebiotic', 'gut health', 'digestive', 'lactobacillus', 'bifidobacterium'],
  sleep_stress:           ['sleep', 'melatonin', 'stress', 'anxiety', 'calm', 'relax', 'l-theanine', 'valerian'],

  // cosmetics_personal_care
  natural_skincare:       ['serum', 'moisturiser', 'moisturizer', 'retinol', 'vitamin c', 'spf', 'sunscreen', 'toner', 'cleanser', 'face wash'],
  hair_care:              ['shampoo', 'conditioner', 'hair mask', 'scalp', 'hair oil', 'hair serum', 'dry shampoo'],
  body_care:              ['body lotion', 'body wash', 'body scrub', 'deodorant', 'body butter', 'exfoliant'],
  color_cosmetics:        ['lipstick', 'foundation', 'mascara', 'eyeliner', 'concealer', 'blush', 'eyeshadow', 'bronzer'],
  mens_grooming:          ["men's", 'beard', 'aftershave', 'shaving', 'grooming'],
  oral_care:              ['toothpaste', 'mouthwash', 'whitening', 'dental', 'oral care', 'floss'],
  fragrance:              ['perfume', 'fragrance', 'eau de', 'cologne', 'scent', 'candle'],

  // home_goods
  kitchen_cookware:       ['cookware', 'pan', 'pot', 'knife', 'cutting board', 'kitchen gadget', 'bakeware', 'blender'],
  home_organisation:      ['storage', 'organiser', 'organizer', 'bin', 'container', 'shelf', 'basket'],
  bedding_textiles:       ['bedding', 'pillow', 'duvet', 'sheet', 'towel', 'throw', 'blanket'],
  cleaning_laundry:       ['cleaning', 'laundry', 'detergent', 'cleaner', 'dishwasher', 'eco clean'],
  home_fragrance_decor:   ['diffuser', 'wax melt', 'room spray', 'candle', 'home fragrance', 'decor', 'ornament'],

  // toys_games
  infant_toddler:         ['baby', 'infant', 'toddler', 'teether', 'rattle', 'sensory', 'baby toy'],
  educational_stem:       ['stem', 'educational', 'learning', 'puzzle', 'science kit', 'coding', 'math'],
  outdoor_active:         ['outdoor', 'active', 'sports toy', 'bike', 'scooter', 'swing', 'trampoline'],
  board_card_games:       ['board game', 'card game', 'tabletop', 'strategy', 'party game'],
  collectibles_figures:   ['collectible', 'figure', 'action figure', 'doll', 'plush', 'stuffed animal'],
};

/** All NCL top-level category → sub-category groupings (used for proximity classification). */
export const CATEGORY_TO_SUBCATEGORIES: Record<string, string[]> = {
  food_beverage:          ['functional_beverages', 'snacks_bars', 'condiments_sauces', 'plant_based_foods', 'coffee_tea', 'confectionery'],
  supplements:            ['collagen_beauty', 'protein_fitness', 'cbd_hemp', 'vitamins_minerals', 'mushroom_adaptogen', 'probiotics_gut', 'sleep_stress'],
  cosmetics_personal_care:['natural_skincare', 'hair_care', 'body_care', 'color_cosmetics', 'mens_grooming', 'oral_care', 'fragrance'],
  home_goods:             ['kitchen_cookware', 'home_organisation', 'bedding_textiles', 'cleaning_laundry', 'home_fragrance_decor'],
  toys_games:             ['infant_toddler', 'educational_stem', 'outdoor_active', 'board_card_games', 'collectibles_figures'],
};

/**
 * Classify a bag of text tokens into the best-matching sub-category.
 * Returns null if no sub-category clears MIN_DENSITY.
 */
export function classifySubCategory(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  const text = tokens.join(' ').toLowerCase();
  let bestLabel: string | null = null;
  let bestScore = 0;

  for (const [label, keywords] of Object.entries(SUBCATEGORY_MAP)) {
    const hits = keywords.filter(kw => text.includes(kw)).length;
    const density = hits / tokens.length;
    if (density > bestScore) {
      bestScore = density;
      bestLabel = label;
    }
  }

  return bestScore >= MIN_DENSITY ? bestLabel : null;
}

/** Return the top-level NCL category that owns a given sub-category label. */
export function topLevelCategory(subCategory: string): string | null {
  for (const [cat, subs] of Object.entries(CATEGORY_TO_SUBCATEGORIES)) {
    if (subs.includes(subCategory)) return cat;
  }
  return null;
}
