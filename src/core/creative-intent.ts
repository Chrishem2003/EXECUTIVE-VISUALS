/**
 * Creative Intent Compiler
 *
 * Converts a human creative brief into a structured, editable production
 * direction. This is deterministic planning logic, not an AI-generation claim.
 */
export interface CreativeIntentInput {
  title: string;
  brief: string;
  audience: string;
  channel: string;
  style: string;
  duration: string;
  desiredFeeling: string;
  differentiator: string;
  proof: string;
  callToAction: string;
  visualSignature: string;
  soundSignature: string;
  constraints: string;
}

export interface CreativeIntentPlan {
  schemaVersion: 1;
  title: string;
  creativePromise: string;
  audienceContract: string;
  emotionalJourney: string[];
  hookAngles: string[];
  visualGrammar: string[];
  soundIdentity: string[];
  storyBeats: string[];
  productionPillars: string[];
  distributionCuts: string[];
  proofAndTrustChecks: string[];
  preflight: string[];
  completenessScore: number;
  completenessLabel: "early direction" | "developing brief" | "production-ready brief";
  missingInputs: string[];
  planningOnly: true;
}

const clean = (value: string) => value.trim().replace(/\s+/g, " ");
const firstSentence = (value: string) => clean(value).split(/[.!?\n]/)[0] || clean(value);
const unique = (values: string[]) => [...new Set(values.map(clean).filter(Boolean))];

export function compileCreativeIntent(input: CreativeIntentInput): CreativeIntentPlan {
  const title = clean(input.title);
  const brief = clean(input.brief);
  if (!title || !brief) throw new Error("A project title and core brief are required.");

  const audience = clean(input.audience) || "The intended audience (define before production)";
  const channel = clean(input.channel) || "Primary channel to be selected";
  const feeling = clean(input.desiredFeeling) || "Curiosity";
  const differentiator = clean(input.differentiator);
  const proof = clean(input.proof);
  const cta = clean(input.callToAction);
  const visual = clean(input.visualSignature);
  const sound = clean(input.soundSignature);
  const constraints = clean(input.constraints);
  const subject = firstSentence(brief);

  const completenessSignals = [audience !== "The intended audience (define before production)", channel !== "Primary channel to be selected", Boolean(differentiator), Boolean(proof), Boolean(cta), Boolean(visual), Boolean(sound), Boolean(constraints), Boolean(clean(input.desiredFeeling))];
  const completenessScore = Math.round(completenessSignals.filter(Boolean).length / completenessSignals.length * 100);
  const missingInputs = unique([
    !differentiator ? "A specific reason this idea should exist instead of another similar production" : "",
    !proof ? "Evidence, demonstration or credible detail that supports the central promise" : "",
    !visual ? "A recognizable visual signature (composition, color, movement or recurring motif)" : "",
    !sound ? "A sonic signature or deliberate sound-design direction" : "",
    !cta ? "The next action the audience should take" : "",
    !constraints ? "Production, rights, brand or delivery constraints" : ""
  ]);

  const hookAngles = unique([
    "Contradiction: challenge the audience's default assumption about " + subject,
    "Consequence: show what changes if " + subject + " is ignored or solved",
    "Curiosity gap: reveal an unexpected detail about " + subject + " before explaining it",
    "Human stakes: open on a person, decision or moment connected to " + subject,
    differentiator ? "Distinctive premise: lead with " + differentiator : ""
  ]);

  const visualGrammar = unique([
    visual ? "Signature: " + visual : "Choose one repeatable visual motif before generating shots",
    "Composition: alternate an intentional establishing image, human-scale detail and decisive close-up",
    "Motion: reserve the strongest camera movement for the story's turning point",
    "Continuity: lock subject appearance, wardrobe, environment, palette and screen direction across related shots",
    "Contrast: make the visual change between problem and payoff legible without relying on text"
  ]);

  const soundIdentity = unique([
    sound ? "Signature: " + sound : "Choose a recurring sonic cue that makes the production recognizable",
    "Dialogue: keep the central message intelligible above music and effects",
    "Transitions: use motivated sound bridges rather than adding effects to every cut",
    "Silence: reserve one deliberate quiet moment for emphasis"
  ]);

  const emotionalJourney = [
    "Entry — earn attention with a concrete image, question or human moment",
    "Tension — make the audience feel why the subject matters",
    "Discovery — introduce a surprising fact, demonstration or perspective",
    "Resolution — deliver the promised emotional shift: " + feeling,
    "Momentum — leave the audience with a useful next thought or action"
  ];

  const storyBeats = [
    "OPEN · " + hookAngles[0],
    "ORIENT · establish who this is for (" + audience + ") and why now",
    "ESCALATE · develop two or three distinct beats; each must add new information",
    "PROVE · " + (proof || "insert a verifiable example, demonstration or source-backed claim"),
    "PAY OFF · resolve the opening question and deliver the intended feeling (" + feeling + ")",
    "INVITE · " + (cta || "define one clear audience action")
  ];

  const distributionCuts = [
    "Hero master · " + input.duration + " · " + channel,
    "Discovery cut · open with the strongest hook; remove all setup that does not earn its place",
    "Proof cut · foreground the demonstration, evidence or result",
    "Human cut · foreground the person, stakes and emotional change",
    "Silent-first cut · communicate the core idea through composition and readable captions",
    "Vertical / square / widescreen adaptations · recompose deliberately; do not merely crop"
  ];

  const proofAndTrustChecks = [
    "Separate factual claims from opinion, dramatization and visual metaphor",
    proof ? "Proof candidate supplied: " + proof : "No proof supplied yet; avoid presenting an unverified claim as fact",
    "Confirm rights for source footage, music, fonts, logos, locations and reference assets",
    "Confirm explicit permission for any real person's likeness or voice transformation",
    "Label synthetic or reconstructed material where context could mislead viewers"
  ];

  const preflight = unique([
    "Audience and channel are explicit",
    differentiator ? "Distinctive premise recorded" : "BLOCKER · define the production's distinctive premise",
    proof ? "Proof candidate recorded for review" : "REVIEW · add evidence before making factual claims",
    visual ? "Visual signature recorded" : "REVIEW · define a visual signature",
    sound ? "Sound identity recorded" : "REVIEW · define a sound identity",
    cta ? "Audience action recorded" : "REVIEW · define the call to action",
    constraints ? "Constraints recorded: " + constraints : "REVIEW · record delivery and rights constraints",
    "This blueprint is planning data only; no model, provider, paid job or publication has been invoked"
  ]);

  return {
    schemaVersion: 1,
    title,
    creativePromise: differentiator || subject,
    audienceContract: audience + " · " + channel + " · " + clean(input.style),
    emotionalJourney,
    hookAngles,
    visualGrammar,
    soundIdentity,
    storyBeats,
    productionPillars: unique([
      "ONE IDEA · every scene must advance the central promise",
      "RECOGNITION · repeat visual and sonic motifs with variation",
      "EVIDENCE · make the payoff believable, not merely impressive",
      "CONTINUITY · protect character, product, location and style identity",
      "ACCESSIBILITY · captions, contrast, intelligible dialogue and clear pacing"
    ]),
    distributionCuts,
    proofAndTrustChecks,
    preflight,
    completenessScore,
    completenessLabel: completenessScore >= 85 ? "production-ready brief" : completenessScore >= 55 ? "developing brief" : "early direction",
    missingInputs,
    planningOnly: true
  };
}

export function formatCreativeIntent(plan: CreativeIntentPlan): string {
  const section = (title: string, values: string[]) => title + "\n" + values.map((value, index) => (index + 1) + ". " + value).join("\n");
  return [
    "CREATIVE DNA · " + plan.title,
    "BRIEF COMPLETENESS · " + plan.completenessScore + "% · " + plan.completenessLabel,
    "CREATIVE PROMISE\n" + plan.creativePromise,
    "AUDIENCE CONTRACT\n" + plan.audienceContract,
    section("EMOTIONAL JOURNEY", plan.emotionalJourney),
    section("HOOK ANGLES", plan.hookAngles),
    section("STORY BEATS", plan.storyBeats),
    section("VISUAL GRAMMAR", plan.visualGrammar),
    section("SOUND IDENTITY", plan.soundIdentity),
    section("PRODUCTION PILLARS", plan.productionPillars),
    section("DISTRIBUTION CUTS", plan.distributionCuts),
    section("PROOF, RIGHTS & TRUST", plan.proofAndTrustChecks),
    section("PREFLIGHT", plan.preflight),
    plan.missingInputs.length ? section("NEXT INPUTS TO STRENGTHEN THE BRIEF", plan.missingInputs) : "NEXT INPUTS\nNo missing direction fields detected.",
    "BOUNDARY\nPlanning blueprint only. No model inference, generation, paid provider call or publishing was performed."
  ].join("\n\n");
}
