/// <reference path="../../definitions/node.d.ts" /> 
/// <reference path="../../definitions/vsts-task-lib.d.ts" /> 
 
import path = require("path");
import tl = require("vsts-task-lib/task");
import fs = require("fs");
import util = require("util");

import env = require("./Environment");

var parameterParse = require("./parser").parse;
var armResource = require("azure-arm-resource");


export class ResourceGroup {

    private connectedServiceNameSelector:string;
    private action:string;
    private actionClassic:string;
    private resourceGroupName:string;
    private location:string;
    private csmFile:string;
    private csmParametersFile:string;
    private overrideParameters:string;
    private subscriptionId:string;
    private connectedService:string;
    private deploymentMode:string;
    private outputVariable:string;
    private credentials;
    
    private networkInterfaces;
    private publicAddresses;
    private virtualMachines;
    
    constructor(action, connectedService, credentials, resourceGroupName, location, csmFile, csmParametersFile, overrideParameters, subscriptionId, deploymentMode, outputVariable) {
            this.connectedService = connectedService;
            this.action = action;
            this.resourceGroupName = resourceGroupName;
            this.location = location;
            this.csmFile = csmFile;
            this.csmParametersFile = csmParametersFile;
            this.overrideParameters = overrideParameters;
            this.subscriptionId = subscriptionId;    
            this.deploymentMode = deploymentMode
            this.credentials = credentials;
            this.outputVariable = outputVariable;
            this.networkInterfaces = null;
            this.publicAddresses = null;
            this.virtualMachines = null;
            this.execute();
    }

    private execute() {
        switch(this.action) {
           case "Create Or Update Resource Group": 
                this.createOrUpdateRG();
                break;
           case "DeleteRG":
                this.deleteResourceGroup();
                break;
           case "Select Resource Group":
                this.selectResourceGroup();
                break;
           default:
               tl.setResult(tl.TaskResult.Succeeded, tl.loc("InvalidAction"));
        }
    }

    private createDeploymentName(filePath:string):string {
        var fileName = path.basename(filePath).split(".")[0].replace(" ", "");
        var ts = new Date(Date.now());
        var depName = util.format("%s-%s%s%s-%s%s",fileName,ts.getFullYear(), ts.getMonth(), ts.getDate(),ts.getHours(), ts.getMinutes());
        return depName;
    } 

    private updateOverrideParameters(params) {
        var override = parameterParse(this.overrideParameters);
        for (var key in override) {
            if (params[key] != undefined)
                params[key]["value"] = override[key];
        }
        return params;
    }
    
    private createOrUpdateRG() {
        var armClient = new armResource.ResourceManagementClient(this.credentials, this.subscriptionId);
        armClient.resourceGroups.checkExistence(this.resourceGroupName, (error, exists, request, response) => {
            if (error) {
                tl.setResult(tl.TaskResult.Failed, tl.loc("ResourceGroupStatusFetchFailed", error))
            }
            if (exists) {
                this.createTemplateDeployment(armClient);
            } else {
                this.createRGIfNotExist(armClient);
            }
        });
    }

    private createRGIfNotExist(armClient) {
        console.log(this.resourceGroupName+" resource Group Not found");
        console.log("Creating a new Resource Group:"+ this.resourceGroupName);
        armClient.resourceGroups.createOrUpdate(this.resourceGroupName, {"name": this.resourceGroupName, "location": this.location}, (error, result, request, response) => {
            if (error) {
                tl.setResult(tl.TaskResult.Failed, tl.loc("ResourceGroupCreationFailed", error))
            } else {
                this.createTemplateDeployment(armClient);
            }
        });
    }
    
    private getParametersFromTemplate(template) {
        var params = {};
        for (var key in template.parameters) {
            params[key] = { value: template.parameters[key]["defaultValue"] };
        }
        return params;
    }

    private createTemplateDeployment(armClient) {
        var template;
        try { 
            template= JSON.parse(fs.readFileSync(this.csmFile, 'UTF-8'));
        }
        catch (error) {
            tl.setResult(tl.TaskResult.Failed, tl.loc("TemplateParsingFailed", error.message));
            return;
        }
        var parameters = this.getParametersFromTemplate(template);
        try {
            if (this.csmParametersFile != undefined && this.csmParametersFile != null && this.csmParametersFile.trim() != "") {
                var parameterFile = JSON.parse(fs.readFileSync(this.csmParametersFile, 'UTF-8')).parameters;
                for (var param in parameterFile) {
                    parameters[param] = parameterFile[param];
                }
            }
            if (this.overrideParameters && this.overrideParameters!=null)
                parameters = this.updateOverrideParameters(properties["parameters"]);
        }
        catch (error) {
            tl.setResult(tl.TaskResult.Failed, tl.loc("ParametersFileParsingFailed", error.message));
            return;
        }
        var properties = {}
        properties["template"] = template;
        properties["parameters"] = parameters;
        properties["mode"] = this.deploymentMode;
        properties["debugSetting"] = {"detailLevel": "requestContent, responseContent"};
        var deployment = {"properties": properties};
        deployment["location"] = this.location;
        armClient.deployments.createOrUpdate(this.resourceGroupName, this.createDeploymentName(this.csmFile), deployment, null, (error, result, request, response) => {
            if (error) {
                tl.setResult(tl.TaskResult.Failed, tl.loc("RGO_createTemplateDeploymentFailed", error.message));
                return;
            }
            try {
                if (this.outputVariable && this.outputVariable.trim() != "")
                    new env.RegisterEnvironment(this.credentials, this.subscriptionId, this.resourceGroupName, this.outputVariable);
            } catch(error) {            
                tl.setResult(tl.TaskResult.Failed, tl.loc("FailedRegisteringEnvironment", error));
                return;
            }
            tl.setResult(tl.TaskResult.Succeeded, tl.loc("RGO_createTemplateDeploymentSucceeded", this.resourceGroupName));
        });
    }

    private deleteResourceGroup() {
        var armClient = new armResource.ResourceManagementClient(this.credentials, this.subscriptionId);
        console.log(tl.loc("ARG_DeletingResourceGroup", this.resourceGroupName));
        armClient.resourceGroups.deleteMethod(this.resourceGroupName,(error, result, request, response) => {
            if (error) {
                tl.setResult(tl.TaskResult.Failed, tl.loc("RGO_CouldNotDeletedResourceGroup", this.resourceGroupName, error.message));
                return;
            }
            tl.setResult(tl.TaskResult.Succeeded, tl.loc("RGO_DeletedResourceGroup", this.resourceGroupName));
        });
    }
    
    private selectResourceGroup() {
        try {
            new env.RegisterEnvironment(this.credentials, this.subscriptionId, this.resourceGroupName, this.outputVariable);

        } catch(error) {            
            tl.setResult(tl.TaskResult.Failed, tl.loc("FailedRegisteringEnvironment", error));
            return;
        }
        tl.setResult(tl.TaskResult.Succeeded, tl.loc("selectResourceGroupSuccessfull", this.resourceGroupName, this.outputVariable))
    }
}