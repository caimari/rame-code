export interface MissionStep {
  id: string;
  title: string;
  successCriterion: string;
}

export interface MissionPlan {
  goal: string;
  assumptions: string[];
  steps: MissionStep[];
  risks: string[];
}
