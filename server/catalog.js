export const formats = Object.freeze([
  {
    id: "fmt_travel",
    slug: "travel-sleeve",
    sku: "SR-T01",
    name: "Travel Sleeve",
    count: 1,
    status: "prelaunch",
    interestOpen: true,
    featured: false,
    structure: "Slim paper sleeve",
    primaryUse: "Trial and travel",
    description: "One hygienically wrapped chewing stick in a slim paper sleeve, designed for trial, hospitality, travel, and sampling.",
    included: ["One wrapped botanical chewing stick", "Quick ritual guide"],
    pricing: null
  },
  {
    id: "fmt_ritual",
    slug: "daily-ritual",
    sku: "SR-R05",
    name: "Daily Ritual",
    count: 5,
    status: "prelaunch",
    interestOpen: true,
    featured: true,
    structure: "Pull-drawer carton",
    primaryUse: "Daily ritual",
    description: "Five hygienically wrapped chewing sticks in a pull-drawer carton, paired with a reusable ventilated travel tube and a clear ritual guide.",
    included: ["Five wrapped botanical chewing sticks", "Reusable ventilated travel tube", "Ritual and care guide"],
    pricing: null
  },
  {
    id: "fmt_family",
    slug: "family-reserve",
    sku: "SR-F12",
    name: "Family Reserve",
    count: 12,
    status: "prelaunch",
    interestOpen: true,
    featured: false,
    structure: "Recloseable paperboard box",
    primaryUse: "Household reserve",
    description: "Twelve hygienically wrapped chewing sticks in a recloseable paperboard format designed for repeat customers and households.",
    included: ["Twelve wrapped botanical chewing sticks", "Recloseable paper band", "Ritual and care guide"],
    pricing: null
  }
]);

export const formatBySlug = new Map(formats.map((format) => [format.slug, format]));
export const formatSlugByName = new Map(formats.map((format) => [format.name.toLowerCase(), format.slug]));
