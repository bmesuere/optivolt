Minimize
 obj: + 0.0075 grid_import_0 - 0.00125 grid_export_0 + 0.007 grid_import_1 - 0.00125 grid_export_1 + 0.01375 grid_import_2 - 0.01125 grid_export_2 + 0.0055 grid_import_3 - 0.00175 grid_export_3 + 0.005 grid_import_4 - 0.002 grid_export_4 + 0.0045 grid_import_5 - 0.00225 grid_export_5 + 0.005 grid_import_6 - 0.00175 grid_export_6 + 0.006 grid_import_7 - 0.0015 grid_export_7

Subject To
 c_power_balance_0: grid_import_0 - grid_export_0 + bat_discharge_0 - bat_charge_0 = 1800
 c_power_balance_1: grid_import_1 - grid_export_1 + bat_discharge_1 - bat_charge_1 = 1500
 c_power_balance_2: grid_import_2 - grid_export_2 + bat_discharge_2 - bat_charge_2 = 1200
 c_power_balance_3: grid_import_3 - grid_export_3 + bat_discharge_3 - bat_charge_3 = 2000
 c_power_balance_4: grid_import_4 - grid_export_4 + bat_discharge_4 - bat_charge_4 = 2500
 c_power_balance_5: grid_import_5 - grid_export_5 + bat_discharge_5 - bat_charge_5 = 2200
 c_power_balance_6: grid_import_6 - grid_export_6 + bat_discharge_6 - bat_charge_6 = 1600
 c_power_balance_7: grid_import_7 - grid_export_7 + bat_discharge_7 - bat_charge_7 = 1400
 soc_0: soc_0 - 0.225 bat_charge_0 + 0.2777777777777778 bat_discharge_0 = 4096
 soc_1: soc_1 - soc_0 - 0.225 bat_charge_1 + 0.2777777777777778 bat_discharge_1 = 0
 soc_2: soc_2 - soc_1 - 0.225 bat_charge_2 + 0.2777777777777778 bat_discharge_2 = 0
 soc_3: soc_3 - soc_2 - 0.225 bat_charge_3 + 0.2777777777777778 bat_discharge_3 = 0
 soc_4: soc_4 - soc_3 - 0.225 bat_charge_4 + 0.2777777777777778 bat_discharge_4 = 0
 soc_5: soc_5 - soc_4 - 0.225 bat_charge_5 + 0.2777777777777778 bat_discharge_5 = 0
 soc_6: soc_6 - soc_5 - 0.225 bat_charge_6 + 0.2777777777777778 bat_discharge_6 = 0
 soc_7: soc_7 - soc_6 - 0.225 bat_charge_7 + 0.2777777777777778 bat_discharge_7 = 0
 import_cap_0: grid_import_0 <= 2500
 export_cap_0: grid_export_0 <= 5000
 charge_cap_0: bat_charge_0 <= 3600
 discharge_cap_0: bat_discharge_0 <= 4000
 import_cap_1: grid_import_1 <= 2500
 export_cap_1: grid_export_1 <= 5000
 charge_cap_1: bat_charge_1 <= 3600
 discharge_cap_1: bat_discharge_1 <= 4000
 import_cap_2: grid_import_2 <= 2500
 export_cap_2: grid_export_2 <= 5000
 charge_cap_2: bat_charge_2 <= 3600
 discharge_cap_2: bat_discharge_2 <= 4000
 import_cap_3: grid_import_3 <= 2500
 export_cap_3: grid_export_3 <= 5000
 charge_cap_3: bat_charge_3 <= 3600
 discharge_cap_3: bat_discharge_3 <= 4000
 import_cap_4: grid_import_4 <= 2500
 export_cap_4: grid_export_4 <= 5000
 charge_cap_4: bat_charge_4 <= 3600
 discharge_cap_4: bat_discharge_4 <= 4000
 import_cap_5: grid_import_5 <= 2500
 export_cap_5: grid_export_5 <= 5000
 charge_cap_5: bat_charge_5 <= 3600
 discharge_cap_5: bat_discharge_5 <= 4000
 import_cap_6: grid_import_6 <= 2500
 export_cap_6: grid_export_6 <= 5000
 charge_cap_6: bat_charge_6 <= 3600
 discharge_cap_6: bat_discharge_6 <= 4000
 import_cap_7: grid_import_7 <= 2500
 export_cap_7: grid_export_7 <= 5000
 charge_cap_7: bat_charge_7 <= 3600
 discharge_cap_7: bat_discharge_7 <= 4000

Bounds
 0 <= grid_import_0 <= 2500
 0 <= grid_export_0 <= 5000
 0 <= bat_charge_0 <= 3600
 0 <= bat_discharge_0 <= 4000
 4096 <= soc_0 <= 20480
 0 <= grid_import_1 <= 2500
 0 <= grid_export_1 <= 5000
 0 <= bat_charge_1 <= 3600
 0 <= bat_discharge_1 <= 4000
 4096 <= soc_1 <= 20480
 0 <= grid_import_2 <= 2500
 0 <= grid_export_2 <= 5000
 0 <= bat_charge_2 <= 3600
 0 <= bat_discharge_2 <= 4000
 4096 <= soc_2 <= 20480
 0 <= grid_import_3 <= 2500
 0 <= grid_export_3 <= 5000
 0 <= bat_charge_3 <= 3600
 0 <= bat_discharge_3 <= 4000
 4096 <= soc_3 <= 20480
 0 <= grid_import_4 <= 2500
 0 <= grid_export_4 <= 5000
 0 <= bat_charge_4 <= 3600
 0 <= bat_discharge_4 <= 4000
 4096 <= soc_4 <= 20480
 0 <= grid_import_5 <= 2500
 0 <= grid_export_5 <= 5000
 0 <= bat_charge_5 <= 3600
 0 <= bat_discharge_5 <= 4000
 4096 <= soc_5 <= 20480
 0 <= grid_import_6 <= 2500
 0 <= grid_export_6 <= 5000
 0 <= bat_charge_6 <= 3600
 0 <= bat_discharge_6 <= 4000
 4096 <= soc_6 <= 20480
 0 <= grid_import_7 <= 2500
 0 <= grid_export_7 <= 5000
 0 <= bat_charge_7 <= 3600
 0 <= bat_discharge_7 <= 4000
 4096 <= soc_7 <= 20480

End
