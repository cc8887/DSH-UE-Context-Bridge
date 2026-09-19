import traceback

import unreal

try:
    import toolset_registry
    unreal.log('[probe] toolset_registry imported')

    from dsh_python_bridge_toolset import python_bridge

    unreal.log(f'[probe] class={python_bridge.DshPythonTools}')

    reg = toolset_registry.Registration([python_bridge.DshPythonTools])
    ok = reg.register()
    unreal.log(f'[probe] registered={ok}')
except Exception:
    unreal.log_error('[probe] failed:\n' + traceback.format_exc())
