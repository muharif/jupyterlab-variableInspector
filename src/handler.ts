import {
    IDisposable
} from '@phosphor/disposable';

import {
    IVariableInspector
} from './variableinspector';

import {
    KernelConnector
} from "./kernelconnector";

import {
    IClientSession
} from "@jupyterlab/apputils";

import {
    KernelMessage
} from "@jupyterlab/services";

import {
    Signal, ISignal
} from "@phosphor/signaling"

import {
    nbformat
} from "@jupyterlab/coreutils"

import {
    JSONModel, DataModel
} from "@phosphor/datagrid";

/**
 * An object that handles code inspection.
 */
export
    class VariableInspectionHandler implements IDisposable, IVariableInspector.IInspectable {

    private _connector: KernelConnector;
    private _queryCommand: string;
    private _initScript: string;
    private _matrixQueryCommand: string;
    private _disposed = new Signal<this, void>( this );
    private _inspected = new Signal<this, IVariableInspector.IVariableInspectorUpdate>( this );
    private _isDisposed = false;
    private _ready : Promise<void>;
    private _id : string;
    

    constructor( options: VariableInspectionHandler.IOptions ) {
        this._connector = options.connector;
        this._id = options.id;
        this._queryCommand = options.queryCommand;
        this._matrixQueryCommand = options.matrixQueryCommand;
        this._initScript = options.initScript;
        
        this._ready =  this._connector.ready.then(() => {
            this._initOnKernel().then(( msg:KernelMessage.IExecuteReplyMsg ) => {
            this._connector.iopubMessage.connect( this._queryCall );
            return;

            } );
        } );
        
        this._connector.kernelRestarted.connect(( sender, kernelReady: Promise<void> ) => {
            
            const title: IVariableInspector.IVariableTitle = {
                    contextName: "<b>Restarting kernel...</b> "
            };
            this._inspected.emit( <IVariableInspector.IVariableInspectorUpdate>{title : title, payload : []});          

            this._ready = kernelReady.then(() => {
                this._initOnKernel().then(( msg: KernelMessage.IExecuteReplyMsg ) => {
                    this._connector.iopubMessage.connect( this._queryCall );
                    this.performInspection();
                } );         
            } );
        } );

    }

    get id():string{
        return this._id;
    }
    
    /**
     * A signal emitted when the handler is disposed.
     */
    get disposed(): ISignal<VariableInspectionHandler, void> {
        return this._disposed;
    }

    get isDisposed(): boolean {
        return this._isDisposed;
    }
    
    get ready():Promise<void>{
        return this._ready;
    }
    

    /**
     * A signal emitted when an inspector value is generated.
     */
    get inspected(): ISignal<VariableInspectionHandler, IVariableInspector.IVariableInspectorUpdate> {
        return this._inspected;
    }

    /**
     * Performs an inspection by sending an execute request with the query command to the kernel.
     */
    public performInspection(): void {
        let request: KernelMessage.IExecuteRequest = {
            code: this._queryCommand,
            stop_on_error: false,
            store_history: false,
        };
        this._connector.fetch( request, this._handleQueryResponse );
    }

    /**
     * Performs an inspection of the specified matrix.
     */

    public performMatrixInspection( varName: string, maxRows=100000 ): Promise<DataModel> {
        let request: KernelMessage.IExecuteRequest = {
            code: this._matrixQueryCommand + "(" + varName + ", " + maxRows + ")",
            stop_on_error: false,
            store_history: false,
        };
        let con = this._connector;
        return new Promise( function( resolve, reject ) {
            con.fetch( request,
                ( response: KernelMessage.IIOPubMessage ) => {
                    let msgType = response.header.msg_type;
                    switch ( msgType ) {
                        case "execute_result":
                            let payload = response.content as nbformat.IExecuteResult;
                            let content: string = <string>payload.data["text/plain"];
                            let modelOptions = <JSONModel.IOptions>JSON.parse( content.replace( /^'|'$/g, "" ) );
                            let jsonModel = new JSONModel( modelOptions );
                            resolve( jsonModel );
                            break;
                        case "error":
                            console.log(response);
                            reject( "Kernel error on 'matrixQuery' call!" );
                            break;
                        default:
                            break;
                    }
                }
            );
        } );
    }


    /*
     * Disposes the kernel connector.
     */
    dispose(): void {
        if ( this.isDisposed ) {
            return;
        }
        this._isDisposed = true;
        this._disposed.emit( void 0 );
        Signal.clearData( this );
    }



    /**
     * Initializes the kernel by running the set up script located at _initScriptPath.
     * TODO: Use script based on kernel language.
     */
    private _initOnKernel(): Promise<KernelMessage.IExecuteReplyMsg> {
        let request: KernelMessage.IExecuteRequest = {
            code: this._initScript,
            stop_on_error: false,
            silent: true,
        };

        let reply: Promise<KernelMessage.IExecuteReplyMsg> = this._connector.fetch( request, ( () => { } ) );
        return reply;
    }
    
    /*
     * Handle query response. Emit new signal containing the IVariableInspector.IInspectorUpdate object.
     * (TODO: query resp. could be forwarded to panel directly)
     */
    private _handleQueryResponse = ( response: KernelMessage.IIOPubMessage ): void => {
        let msgType = response.header.msg_type.split("_", 1)[0];
        switch ( msgType ) {
            case "execute":
                let payload = response.content as nbformat.IExecuteResult;
                let content: string = <string>payload.data["text/plain"];
                if (content.slice(0, 1) == "'" || content.slice(0, 1) == "\""){
                    content = content.slice(1,-1);
                    content = content.replace( /\\"/g, "\"" ).replace( /\\'/g, "\'" );
                }

                let update: IVariableInspector.IVariable[];
                update = <IVariableInspector.IVariable[]>JSON.parse( content );

                let title: IVariableInspector.IVariableTitle;
                title = {
                    contextName: "",
                    kernelName : this._connector.kernelname || "",
                    languageName : this._connector.kerneltype || ""
                };

                this._inspected.emit( {title: title, payload: update} );
                break;
            case "display":
                let payload_display = response.content as nbformat.IExecuteResult;
                let content_display: string = <string>payload_display.data["text/plain"];
                if (content_display.slice(0, 1) == "'" || content_display.slice(0, 1) == "\""){
                    content_display = content_display.slice(1,-1);
                    content_display = content_display.replace( /\\"/g, "\"" ).replace( /\\'/g, "\'" );
                }

                let update_display: IVariableInspector.IVariable[];
                update_display = <IVariableInspector.IVariable[]>JSON.parse( content_display );

                let title_display: IVariableInspector.IVariableTitle;
                title_display = {
                    contextName: "",
                    kernelName : this._connector.kernelname || "",
                    languageName : this._connector.kerneltype || ""
                };

                this._inspected.emit( {title: title_display, payload: update_display} );
                break;
            default:
                break;
        }
    };

    /*
     * Invokes a inspection if the signal emitted from specified session is an 'execute_input' msg.
     */
    private _queryCall = ( sess: IClientSession, msg: KernelMessage.IMessage ) => {
        let msgType = msg.header.msg_type;
        switch ( msgType ) {
            case 'execute_input':
                let code = msg.content.code;
                if ( !( code == this._queryCommand ) && !( code == this._matrixQueryCommand ) ) {
                    this.performInspection();
                }
                break;
            default:
                break;
        }
    };
}

/**
 * A name space for inspection handler statics.
 */
export
namespace VariableInspectionHandler {
    /**
     * The instantiation options for an inspection handler.
     */
    export
        interface IOptions {
        connector: KernelConnector;
        queryCommand: string;
        matrixQueryCommand: string;
        initScript: string;
        id : string;
    }
}

export
    class DummyHandler implements IDisposable, IVariableInspector.IInspectable{
        private _isDisposed = false;
        private _disposed = new Signal<this,void>( this );
        private _inspected = new Signal<this, IVariableInspector.IVariableInspectorUpdate>( this );
        private _connector : KernelConnector;
        
        constructor(connector : KernelConnector) {
            this._connector = connector;
        }
                
        get disposed() : ISignal<DummyHandler, void>{
            return this._disposed;
        }
       
        get isDisposed() : boolean {
            return this._isDisposed;
        }
       
        get inspected() : ISignal<DummyHandler, IVariableInspector.IVariableInspectorUpdate>{
            return this._inspected;
        }
       
        dispose(): void {
            if ( this.isDisposed ) {
                return;
            }
            this._isDisposed = true;
            this._disposed.emit( void 0 );
            Signal.clearData( this );
        }
       
        public performInspection(): void{
            let title: IVariableInspector.IVariableTitle;
            title = {
                contextName: ". <b>Language currently not supported.</b> ",
                kernelName : this._connector.kernelname || "",
                languageName : this._connector.kerneltype || ""
            };
            this._inspected.emit( <IVariableInspector.IVariableInspectorUpdate>{title : title, payload : []});
        }
        
        public performMatrixInspection(varName : string, maxRows : number): Promise<DataModel>{
            return new Promise(function(resolve, reject) { reject("Cannot inspect matrices w/ the DummyHandler!") });
        }
}