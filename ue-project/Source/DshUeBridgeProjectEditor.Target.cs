using UnrealBuildTool;
using System.Collections.Generic;

public class DshUeBridgeProjectEditorTarget : TargetRules
{
	public DshUeBridgeProjectEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.V5;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("DshUeBridgeProject");
	}
}
