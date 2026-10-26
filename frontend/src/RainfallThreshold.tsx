export type RainfallThreshold =
  | { status: "unavailable"; reason: string }
  | {
      status: "available";
      observationId: string;
      assessmentId: string;
      scope: "basin" | "segment";
      durationMinutes: number;
      probability: number;
      depthMm: number;
      intensityMmH: number;
      depthUnit: string;
      intensityUnit: string;
      assessmentDate: string;
      version: string;
      sourceUrl: string;
      downloadUrl: string;
      archive: string;
      archiveSha256: string;
      layer: string;
      matchedFeatureParts: number;
      limitation: string;
    };
